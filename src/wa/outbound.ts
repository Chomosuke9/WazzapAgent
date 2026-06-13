/**
 * outbound.js — Send messages, media, and mentions to WhatsApp.
 *
 * The main entry point is sendOutgoing() which handles:
 *   - Attachment sending (image, video, audio, sticker, document)
 *   - Mention resolution: @Name (senderRef) → actual JIDs
 *   - Interactive mode (sendRichMessage) vs plain text (sock.sendMessage)
 *   - Reply quoting via contextMsgId → WhatsApp message key lookup
 *
 * Mention format: "Hello @Alice (u8k2d1) @Bob (u3m9x7)"
 * The renderOutboundMentions() function resolves senderRef tokens to JIDs and
 * produces the WhatsApp mentions array. Invalid senderRef tokens are silently
 * stripped (the rest of the message still sends).
 *
 * Special mention: @all (all) → sets nonJidMentions in contextInfo so WhatsApp
 * notifies all group participants without listing each JID individually.
 */
import path from 'path';
import logger from '../logger.js';
import type { AnyMessageContent } from 'baileys';
import {
  normalizeJid,
  normalizeContextMsgId,
  nextContextMsgId,
  rememberSenderRef,
  rememberMessage,
  isContactJid,
  resolveMentionTargetBySenderRef,
  mentionHandleForJid,
  resolveQuotedMessage,
} from './domain/identifiers.js';
import { getGroupContext } from './domain/groupContext.js';
import {
  resolveAllowedAttachmentPath,
  detectMimeFromFile,
  normalizeMime,
  inferExtension,
} from '../mediaHandler.js';
import { actionError } from './actions.js';
import { sendRichMessage } from './interactive/index.js';
import config from '../config.js';
import type { GroupContextValue, ParticipantRoleFlags } from './domain/caches.js';
import type { SentEntry } from '../protocol/types.js';
import type { AccountContext } from '../account/accountContext.js';

/** Type accepted by mediaHandler's resolveAllowedAttachmentPath error factory. */
type ActionErrorFactory = (code: string, message: string) => Error;

/** Result of resolving outbound mention tokens against the senderRef registry. */
interface RenderedMentions {
  text: string;
  mentions: string[];
  nonJidMentions: number;
  adminGroupMention?: { groupJid: string; groupSubject: string } | null;
  groupContext: GroupContextValue | null;
}

/**
 * Resolve @Name (senderRef) mention tokens in outbound text to WhatsApp JIDs.
 *
 * Supports three mention types:
 *   - @Name (senderRef)   → resolved to a phone JID via senderRefRegistry
 *   - @all (all)          → sets nonJidMentions count (WhatsApp tags everyone)
 *   - @Name (bot)         → rendered as @Name without JID (bot self-mention)
 *
 * Invalid senderRef tokens are left as-is (silently skipped for mention array).
 */
async function renderOutboundMentions(
  ctx: AccountContext,
  chatId: string,
  rawText: string,
  groupContext: GroupContextValue | null = null,
): Promise<RenderedMentions> {
  if (typeof rawText !== 'string') {
    return { text: rawText, mentions: [], nonJidMentions: 0, groupContext };
  }
  // Match @Name (senderRef) pattern — name can contain spaces, non-greedy to handle multiple mentions
  const tokens = Array.from(rawText.matchAll(/@(.+?)\s*\(([^)\r\n]+)\)/g));
  if (tokens.length === 0) {
    return { text: rawText, mentions: [], nonJidMentions: 0, groupContext };
  }

  let resolvedGroup = groupContext;
  let retried = false;
  let cursor = 0;
  let rendered = '';
  const mentionSet = new Set<string>();
  let nonJidMentions = 0;
  let hasAdminMention = false;

  for (const token of tokens) {
    const fullToken = token[0];
    const rawName = typeof token[1] === 'string' ? token[1].trim() : '';
    const rawValue = typeof token[2] === 'string' ? token[2].trim() : '';
    const normalizedValue = rawValue.toLowerCase();
    const index = Number.isInteger(token.index) ? (token.index as number) : -1;
    if (index < 0) continue;

    rendered += rawText.slice(cursor, index);
    let replacement = rawName ? `@${rawName}` : '@';

    if (normalizedValue === 'all') {
      // @all (all) — tag everyone in the group using nonJidMentions
      // instead of listing every participant JID individually.
      // Only effective in group chats.
      if (chatId?.endsWith('@g.us')) {
        nonJidMentions += 1;
      }
      replacement = '@all';
    } else if (normalizedValue === 'bot') {
      // Bot mention — render as display name, no JID resolution needed
      replacement = rawName ? `@${rawName}` : '@bot';
    } else if (normalizedValue === 'admin') {
      // @admin (admin) — tag all group admins using groupMentions trick.
      // WhatsApp renders a group JID mention as "@admin" when groupSubject = "admin".
      // The replacement text must be the FULL group JID (e.g. @120363408109130578@g.us),
      // NOT just the local part and NOT the literal "@admin" — WhatsApp maps the full
      // JID token to groupMentions and derives the display text from groupSubject.
      if (chatId?.endsWith('@g.us')) {
        if (!resolvedGroup) {
          resolvedGroup = await getGroupContext(ctx, chatId);
        }
        // Collect admin JIDs from participantRoles.
        // participantRoles values are { isAdmin, isSuperAdmin } objects (not strings).
        const adminJids: string[] = [];
        const roles: Record<string, ParticipantRoleFlags> = resolvedGroup?.participantRoles || {};
        for (const [jid, roleFlags] of Object.entries(roles)) {
          if (roleFlags?.isAdmin || roleFlags?.isSuperAdmin) {
            const normalized = normalizeJid(jid) || jid;
            if (normalized) adminJids.push(normalized);
          }
        }
        // Add each admin JID to the mention set so they get notified
        for (const jid of adminJids) {
          mentionSet.add(jid);
        }
        // Signal to inject a groupMentions entry so WhatsApp renders "@admin"
        hasAdminMention = true;
      }
      // Replacement must be the full group JID (e.g. @120363408109130578@g.us)
      // so WhatsApp can resolve groupMentions and render it as "@admin" in the UI.
      // Using only the local part (@120363408109130578) does NOT work — WhatsApp
      // requires the complete JID including @g.us.
      replacement = chatId ? `@${chatId}` : '@admin';
    } else if (normalizedValue) {
      let participantJid = resolveMentionTargetBySenderRef(ctx, chatId, normalizedValue);
      if (!participantJid && !retried && chatId?.endsWith('@g.us')) {
        logger.debug({ chatId, senderRef: normalizedValue }, 'senderRef not found — force-refreshing group metadata');
        resolvedGroup = await getGroupContext(ctx, chatId, { forceRefresh: true });
        retried = true;
        participantJid = resolveMentionTargetBySenderRef(ctx, chatId, normalizedValue);
      }
      if (participantJid) {
        const normalizedParticipant = normalizeJid(participantJid) || participantJid;
        mentionSet.add(normalizedParticipant);
        replacement = mentionHandleForJid(normalizedParticipant) || replacement;
      } else {
        logger.warn({ chatId, senderRef: normalizedValue }, 'outbound mention resolution failed — token will render as plain text');
      }
    }

    rendered += replacement;
    cursor = index + fullToken.length;
  }

  rendered += rawText.slice(cursor);
  const mentionsArray = Array.from(mentionSet);
  for (const jid of mentionsArray) {
    if (!isContactJid(jid)) {
      logger.warn({ chatId, jid }, 'outbound mention contains non-contact JID — may not render as clickable');
    }
  }
  return {
    text: rendered,
    mentions: mentionsArray,
    nonJidMentions,
    adminGroupMention: hasAdminMention ? { groupJid: chatId, groupSubject: 'admin' } : null,
    groupContext: resolvedGroup,
  };
}

/**
 * Resolve the most accurate mimetype for an outbound attachment.
 *
 * Order of preference:
 *   1. Caller-provided ``att.mime`` / ``att.mimetype`` (Python forwards the
 *      result of ``bridge.subagent.output.detect_kind``, which already does
 *      magic-byte sniffing). Skip if it's just ``application/octet-stream``
 *      so we still try to do better below.
 *   2. Magic-byte sniff of the actual file content via
 *      ``detectMimeFromFile`` — this catches files where the extension lies
 *      or is missing entirely.
 *   3. Extension-based guess via ``inferExtension`` reversed (best-effort).
 *
 * For non-document kinds we additionally bias toward the kind's typical
 * mimetype when no other signal is available so Baileys' validation passes.
 */
async function resolveAttachmentMimetype(att: any, filePath: string, kind: string): Promise<string | null> {
  const declared = normalizeMime(att?.mime || att?.mimetype);
  if (declared && declared !== 'application/octet-stream') return declared;

  const sniffed = await detectMimeFromFile(filePath);
  if (sniffed) return sniffed;

  if (declared) return declared;
  if (kind === 'image') return 'image/jpeg';
  if (kind === 'video') return 'video/mp4';
  if (kind === 'audio') return 'audio/mp4';
  if (kind === 'sticker') return 'image/webp';
  return null;
}

/**
 * Ensure a filename carries a sensible extension.
 *
 * WhatsApp clients open documents using the filename extension, not the
 * mimetype, so a document called ``report`` with mimetype
 * ``application/pdf`` will open as ``report`` and be treated as text.
 * Append a best-guess extension when the basename has none.
 *
 * If ``fileName`` is empty or not a string, fall back to ``filePathBasename``
 * (the basename of the file path) — this ensures we always use the original
 * filename rather than a generic placeholder like "file".
 */
function ensureFileNameHasExtension(
  fileName: string | null | undefined,
  mime: string | null,
  filePathBasename: string,
): string {
  const safe = typeof fileName === 'string' && fileName.trim()
    ? fileName.trim()
    : (typeof filePathBasename === 'string' && filePathBasename.trim() ? filePathBasename.trim() : 'file');
  const ext = path.extname(safe);
  if (ext) return safe;
  const inferred = inferExtension(mime);
  if (!inferred || inferred === 'bin') return safe;
  return `${safe}.${inferred}`;
}

/**
 * Send a message (text, media, or both) to WhatsApp.
 *
 * Handles attachment sending (image/video/audio/sticker/document with optional caption),
 * mention resolution, reply quoting, and interactive mode fallback.
 *
 * If config.llmReplyInteractive is true, text replies use sendRichMessage (NativeFlow)
 * which renders nicely on mobile but is invisible on WhatsApp Web.
 * If false (default), plain sock.sendMessage is used (works everywhere).
 */
async function sendOutgoing(ctx: AccountContext, {
  chatId,
  text,
  attachments = [],
  replyTo,
}: {
  chatId: string;
  text?: string;
  attachments?: any[];
  replyTo?: string | null;
}): Promise<{ sent: SentEntry[]; replyTo: string | null }> {
  const sock = ctx.sock;
  if (!sock) throw actionError('send_failed', 'WhatsApp socket not ready');
  if (!chatId) throw actionError('invalid_target', 'chatId is required');
  if (attachments != null && !Array.isArray(attachments)) {
    throw actionError('invalid_target', 'attachments must be an array');
  }

  const quoted = replyTo ? resolveQuotedMessage(ctx, chatId, replyTo) : null;
  if (replyTo && !quoted) {
    throw actionError('not_found', 'reply target not found');
  }

  const isGroup = chatId.endsWith('@g.us');
  let group = isGroup ? await getGroupContext(ctx, chatId) : null;
  const botSenderId = normalizeJid(sock.user?.id) || 'bot@wazzap.local';
  const botSenderRef = rememberSenderRef(ctx, chatId, botSenderId, botSenderId) || 'unknown';
  const normalizedText = typeof text === 'string' ? text.trim() : '';
  const normalizedAttachments = Array.isArray(attachments) ? attachments : [];
  if (!normalizedText && normalizedAttachments.length === 0) {
    throw actionError('invalid_target', 'send_message requires non-empty text or at least one attachment');
  }
  const sent: SentEntry[] = [];

  // send attachments first (with caption if provided)
  for (const att of normalizedAttachments) {
    const kindToken = typeof att?.kind === 'string' ? att.kind : (typeof att?.type === 'string' ? att.type : 'document');
    const kind = kindToken.trim().toLowerCase() || 'document';
    const filePath = await resolveAllowedAttachmentPath(att?.path, actionError as ActionErrorFactory, {
      mediaDir: ctx.mediaDir,
      stickersDir: ctx.stickersDir,
      stickerUploadDir: ctx.stickerUploadDir,
    });
    const resolvedMime = await resolveAttachmentMimetype(att, filePath, kind);
    // Determine a display filename for ALL media types. WhatsApp uses
    // ``fileName`` primarily for documents, but including it for images,
    // videos, and audio ensures the original name is preserved wherever
    // the client makes it visible (e.g. file details, save-to-disk).
    const filePathBasename = path.basename(filePath);
    const fileName = (typeof att?.fileName === 'string' && att.fileName.trim())
      ? att.fileName.trim()
      : filePathBasename;
    const safeFileName = ensureFileNameHasExtension(fileName, resolvedMime, filePathBasename);
    const content: Record<string, any> = {};
    // Decode the base64 thumbnail if provided — WhatsApp needs raw bytes
    // for the ``jpegThumbnail`` field.  The Python bridge sends the
    // thumbnail as a base64 string inside the JSON payload because b64
    // is JSON-safe; we decode it to a Buffer here.
    const thumbnailBase64 = typeof att?.thumbnailBase64 === 'string' && att.thumbnailBase64.trim()
      ? att.thumbnailBase64.trim()
      : undefined;
    const thumbnailBuffer = thumbnailBase64
      ? Buffer.from(thumbnailBase64, 'base64')
      : undefined;
    if (kind === 'image') content.image = { url: filePath };
    else if (kind === 'video') content.video = { url: filePath };
    else if (kind === 'audio') content.audio = { url: filePath, ptt: false };
    else if (kind === 'sticker') content.sticker = { url: filePath };
    else {
      content.document = { url: filePath };
      // Attach the JPEG thumbnail for document previews. Without
      // ``jpegThumbnail`` WhatsApp shows a blank white rectangle for
      // non-PDF documents.  The thumbnail is generated by the Python
      // bridge (pypdfium2 for PDFs, Pillow for images, placeholder
      // icons for Office formats) and passed as base64 in the WS payload.
      // NOTE: ``jpegThumbnail`` must be a top-level property on the
      // content object, NOT nested inside ``document``.  Baileys v7
      // spreads the top-level properties into ``uploadData`` and then
      // deletes the media-type key (``document``); any field nested
      // inside it is lost.  The same applies to ``fileName`` — see
      // WhiskeySockets/Baileys prepareWAMessageMedia().
      if (thumbnailBuffer) {
        content.jpegThumbnail = thumbnailBuffer;
      }
    }
    // Pin the filename on ALL media types so WhatsApp preserves the
    // original name wherever it surfaces it (document header, image
    // file-details, save-to-disk, etc.).
    // NOTE: For documents, ``fileName`` MUST be a top-level property.
    // Baileys v7 expects ``fileName`` alongside ``document``, not nested
    // inside it.  Putting it inside ``content.document`` causes Baileys
    // to default the name to "file" — see prepareWAMessageMedia().
    if (kind !== 'sticker') {
      content.fileName = safeFileName;
    }
    // Always pin the mimetype so Baileys does not fall back to its own
    // guess. For documents in particular, an unrecognized stream is
    // rendered as application/pdf, which produces unopenable messages.
    if (resolvedMime) content.mimetype = resolvedMime;

    if (att.caption) {
      const renderedCaption = await renderOutboundMentions(ctx, chatId, String(att.caption), group);
      content.caption = renderedCaption.text;
      if (renderedCaption.mentions.length > 0) {
        content.mentions = renderedCaption.mentions;
      }
      if (renderedCaption.nonJidMentions > 0) {
        content.contextInfo = { ...content.contextInfo, nonJidMentions: renderedCaption.nonJidMentions };
      }
      group = renderedCaption.groupContext || group;
    }

    const sentMsg = await sock.sendMessage(chatId, content as AnyMessageContent, quoted ? { quoted } : {});
    const contextMsgId = nextContextMsgId(ctx, chatId);
    rememberMessage(ctx, sentMsg, {
      chatId,
      contextMsgId,
      senderId: botSenderId,
      senderRef: botSenderRef,
      senderIsAdmin: Boolean(group?.botIsAdmin),
      fromMe: true,
      timestampMs: Date.now(),
    });
    sent.push({
      kind,
      contextMsgId,
      messageId: sentMsg?.key?.id || null,
    });
  }

  if (normalizedText) {
    const renderedText = await renderOutboundMentions(ctx, chatId, normalizedText, group);
    group = renderedText.groupContext || group;
    let sentMsg: any;
    if (config.llmReplyInteractive) {
      // Interactive mode: sendRichMessage with optional footer.
      // Note: not compatible with WhatsApp Web (viewOnceMessage wrapper).
      try {
        sentMsg = await sendRichMessage(sock, chatId, {
          text: renderedText.text,
          footer: config.llmReplyFooter || undefined,
          quoted: quoted || undefined,
          mentions: renderedText.mentions,
          nonJidMentions: renderedText.nonJidMentions,
          adminGroupMention: renderedText.adminGroupMention || null,
        } as Parameters<typeof sendRichMessage>[2]);
      } catch (err) {
        logger.warn({ err, chatId }, 'sendRichMessage failed, falling back to sendMessage');
        const textPayload: Record<string, any> = { text: renderedText.text };
        if (renderedText.mentions.length > 0) textPayload.mentions = renderedText.mentions;
        if (renderedText.nonJidMentions > 0) {
          textPayload.contextInfo = { ...textPayload.contextInfo, nonJidMentions: renderedText.nonJidMentions };
        }
        if (renderedText.adminGroupMention) {
          textPayload.contextInfo = { ...textPayload.contextInfo, groupMentions: [renderedText.adminGroupMention] };
        }
        sentMsg = await sock.sendMessage(chatId, textPayload as AnyMessageContent, quoted ? { quoted } : {});
      }
    } else {
      // Default: plain sendMessage. Works on all clients including WhatsApp Web.
      const bodyText = config.llmReplyFooter
        ? `${renderedText.text}\n\n${config.llmReplyFooter}`
        : renderedText.text;
      const textPayload: Record<string, any> = { text: bodyText };
      if (renderedText.mentions.length > 0) textPayload.mentions = renderedText.mentions;
      if (renderedText.nonJidMentions > 0) {
        textPayload.contextInfo = { ...textPayload.contextInfo, nonJidMentions: renderedText.nonJidMentions };
      }
      if (renderedText.adminGroupMention) {
        textPayload.contextInfo = { ...textPayload.contextInfo, groupMentions: [renderedText.adminGroupMention] };
      }
      sentMsg = await sock.sendMessage(chatId, textPayload as AnyMessageContent, quoted ? { quoted } : {});
    }

    const contextMsgId = nextContextMsgId(ctx, chatId);
    rememberMessage(ctx, sentMsg, {
      chatId,
      contextMsgId,
      senderId: botSenderId,
      senderRef: botSenderRef,
      senderIsAdmin: Boolean(group?.botIsAdmin),
      fromMe: true,
      timestampMs: Date.now(),
    });
    sent.push({
      kind: 'text',
      contextMsgId,
      messageId: sentMsg?.key?.id || null,
    });
  }
  if (sent.length === 0) {
    throw actionError('invalid_target', 'send_message produced no deliverable content');
  }

  return {
    sent,
    replyTo: normalizeContextMsgId(replyTo),
  };
}

/**
 * Send a Lottie/premium WhatsApp sticker by relaying its original message payload.
 *
 * Instead of re-uploading a degraded .webp file, we reconstruct the original
 * ``lottieStickerMessage`` from the JSON stored in the DB and relay it verbatim
 * using Baileys ``relayMessage``. This preserves the Lottie animation fully.
 *
 * When ``replyTo`` (a contextMsgId) is provided, the reply context is injected
 * into the inner ``stickerMessage.contextInfo`` so the sticker appears as a
 * reply to the target message — matching the behaviour of regular stickers.
 */
async function sendLottieSticker(
  ctx: AccountContext,
  chatId: string,
  lottiePayloadJson: string,
  replyTo?: string,
): Promise<{ contextMsgId: string; messageId: string | null }> {
  const sock = ctx.sock;
  if (!sock) throw actionError('send_failed', 'WhatsApp socket not ready');
  if (!chatId) throw actionError('invalid_target', 'chatId is required');

  let lottiePayload: any;
  try {
    lottiePayload = JSON.parse(lottiePayloadJson);
  } catch (err) {
    throw actionError('invalid_target', `Invalid Lottie payload JSON: ${(err as { message?: string })?.message}`);
  }

  // Inject reply context into the inner stickerMessage if a replyTo is specified.
  // Lottie stickers are relayed via relayMessage (not sendMessage), so we
  // must manually construct the contextInfo instead of using the `quoted` param.
  if (replyTo) {
    const quoted = resolveQuotedMessage(ctx, chatId, replyTo);
    if (quoted) {
      // The lottiePayload structure is: { message: { stickerMessage: { ... } } }
      // We inject contextInfo into the inner stickerMessage.
      const innerSticker =
        lottiePayload?.message?.stickerMessage || lottiePayload?.stickerMessage;
      if (innerSticker) {
        innerSticker.contextInfo = {
          stanzaId: quoted.key?.id,
          participant: quoted.key?.participant || quoted.key?.remoteJid,
          quotedMessage: quoted.message || { conversation: '' },
        };
      }
    }
  }

  // Wrap the stored lottieStickerMessage back into a full message object
  // for generateWAMessageFromContent.
  const messageContent = { lottieStickerMessage: lottiePayload };

  const { generateWAMessageFromContent, generateMessageIDV2 } = await import('baileys');

  const wrappedMsg = generateWAMessageFromContent(chatId, messageContent, {
    userJid: sock.user?.id as string,
  });

  await sock.relayMessage(chatId, wrappedMsg.message!, {
    messageId: wrappedMsg.key?.id || generateMessageIDV2(sock.user?.id),
  });

  const sentMsg = wrappedMsg;
  const botSenderId = normalizeJid(sock.user?.id) || 'bot@wazzap.local';
  const botSenderRef = rememberSenderRef(ctx, chatId, botSenderId, botSenderId) || 'unknown';
  const contextMsgId = nextContextMsgId(ctx, chatId);
  rememberMessage(ctx, sentMsg, {
    chatId,
    contextMsgId,
    senderId: botSenderId,
    senderRef: botSenderRef,
    senderIsAdmin: false,
    fromMe: true,
    timestampMs: Date.now(),
  });

  logger.debug(
    'outbound',
    {
      chat_id: chatId,
      action: 'send_lottie_sticker',
      context_msg_id: contextMsgId,
      message_id: sentMsg?.key?.id || null,
    },
  );

  return {
    contextMsgId,
    messageId: sentMsg?.key?.id || null,
  };
}

export {
  renderOutboundMentions,
  sendOutgoing,
  sendLottieSticker,
};
