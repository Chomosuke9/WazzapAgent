/**
 * inbound.js — Transform WhatsApp messages into normalized payloads for the Python bridge.
 *
 * This module handles the critical step between Baileys' raw message events and the
 * structured `incoming_message` payload that the Python bridge processes:
 *
 *   1. Parse group join stubs (emit as synthetic context events instead of forwarding)
 *   2. Normalize sender identity: JID → senderRef, resolve display names
 *   3. Determine bot-mention and replied-to-bot signals for LLM1 routing
 *   4. Download and validate media attachments (image/video/audio/document/sticker)
 *   5. Extract quoted (replied-to) messages with full metadata
 *   6. Build the final payload with all context needed by the LLM pipeline
 *
 * Bot messages (fromMe=true) are forwarded with `contextOnly=true` and
 * `triggerLlm1=false` so they enrich context without causing response loops.
 */
import logger from '../logger.js';
import config from '../config.js';
import {
  normalizeJid,
  normalizeContextMsgId,
  ensureContextMsgId,
  rememberSenderRef,
  rememberMessage,
} from './domain/identifiers.js';
import {
  rememberParticipantName,
  lookupParticipantName,
  roleFlagsForJid,
  fallbackParticipantLabel,
  compactParticipantJids,
  isOwnerJid,
} from './domain/participants.js';
import {
  getGroupContext,
  normalizeGroupJoinAction,
  invalidateGroupMetadata,
  parseGroupJoinStub,
  getGroupParticipantName,
  currentBotAliases,
} from './domain/groupContext.js';
import {
  unwrapMessage,
  extractMentionedJids,
  extractLocationData,
  formatLocationText,
  extractText,
  extractQuoted,
} from './domain/messageParser.js';
import { saveMedia } from '../mediaHandler.js';
import { withTimeout, escapeRegex } from './utils.js';
import {
  resolveParticipantLabel,
  emitGroupJoinContextEvent,
  emitBotRoleChangeEvent,
} from './events.js';
import { parseSlashCommand } from './command/index.js';
import type { WhatsAppMessagePayload, AccountEntry } from '../protocol/types.js';
import type { AccountContext } from '../account/accountContext.js';

/** Resolved mention row as embedded in inbound payloads. */
interface MentionedParticipant {
  jid: string;
  senderRef: string | null;
  name: string;
  isBot: boolean;
}

async function buildMentionedParticipants(
  ctx: AccountContext,
  chatId: string,
  mentionedJids: unknown,
  botAliasSet: Set<string> | null = null,
): Promise<MentionedParticipant[] | null> {
  if (!Array.isArray(mentionedJids) || mentionedJids.length === 0) return null;
  const normalizedMentions = Array.from(new Set(
    mentionedJids
      .map((jid) => normalizeJid(jid) || jid)
      .filter(Boolean)
  ));
  if (normalizedMentions.length === 0) return null;

  const rows: MentionedParticipant[] = [];
  for (const participantJid of normalizedMentions) {
    const normalized = normalizeJid(participantJid) || participantJid;
    if (!normalized) continue;
    const name = await resolveParticipantLabel(ctx, chatId, normalized);
    const senderRef = rememberSenderRef(ctx, chatId, normalized, normalized) || null;
    const isBot = Boolean(
      botAliasSet instanceof Set
      && (botAliasSet.has(normalized) || botAliasSet.has(participantJid))
    );
    rows.push({
      jid: normalized,
      senderRef,
      name: name || fallbackParticipantLabel(normalized),
      isBot,
    });
  }
  return rows.length > 0 ? rows : null;
}

async function handleGroupParticipantsUpdate(ctx: AccountContext, update: any): Promise<void> {
  const sock = ctx.sock;
  if (!sock) return;
  const chatId = update?.id;
  if (!chatId || !chatId.endsWith('@g.us')) return;

  const rawAction = typeof update?.action === 'string' ? update.action.toLowerCase() : '';
  const participants = compactParticipantJids(Array.isArray(update?.participants) ? update.participants : []);
  if (participants.length === 0) return;
  const actorId = compactParticipantJids([update?.authorPn, update?.author])[0] || null;

  // Handle promote/demote: invalidate AFTER event emission so that
  // emitBotRoleChangeEvent can read cached group name/description
  const roleActions = new Set(['promote', 'demote']);
  if (roleActions.has(rawAction)) {
    const botAliases = new Set(currentBotAliases(ctx));
    const botAffected = participants.some((p) => botAliases.has(normalizeJid(p) || p));
    if (botAffected) {
      emitBotRoleChangeEvent(ctx, {
        chatId,
        action: rawAction,
        actorId,
      });
    }
    invalidateGroupMetadata(ctx, chatId);
    return;
  }

  // Handle join events: invalidate before (emitGroupJoinContextEvent
  // already forceRefreshes via getGroupContext)
  invalidateGroupMetadata(ctx, chatId);
  const action = normalizeGroupJoinAction(rawAction);
  const joinActions = new Set(['add', 'invite', 'join', 'approve']);
  if (!joinActions.has(action)) return;

  await emitGroupJoinContextEvent(ctx, {
    chatId,
    action,
    participants,
    actorId,
    timestampMs: Date.now(),
    source: 'group-participants.update',
  });
}

/**
 * Handle a single incoming WhatsApp message.
 *
 * Builds a normalized `incoming_message` payload and sends it to the Python
 * bridge via the account registry (best-effort `incoming_message`). Key behaviors:
 *
 *   - Bot's own messages are sent with `contextOnly=true`, `triggerLlm1=false`
 *   - Reaction messages are sent as `contextOnly=true` (no need for LLM response)
 *   - Interactive message replies are marked `contextOnly=true` (already handled by button handler)
 *   - Slash commands are detected and included in the payload for context enrichment,
 *     but command execution is handled in connection.js before this runs
 *
 * Performance: Logs slow processing if total time exceeds PERF_LOG_THRESHOLD_MS.
 */
async function handleIncomingMessage(
  entry: AccountEntry,
  msg: any,
  { precomputedContextMsgId = null }: { precomputedContextMsgId?: string | null } = {},
): Promise<void> {
  const ctx = entry.ctx;
  const sock = ctx.sock;
  if (!sock) return;
  const perfStartMs = Date.now();
  const perf = {
    groupMs: 0,
    quotedMs: 0,
    mediaMs: 0,
  };

  const stubEvent = parseGroupJoinStub(msg);
  if (stubEvent) {
    await emitGroupJoinContextEvent(ctx, stubEvent);
    return;
  }

  if (!msg.message) return;
  const remoteJid = msg.key.remoteJid;
  if (!remoteJid || remoteJid === 'status@broadcast') return;

  const chatId = remoteJid;
  const isGroup = chatId.endsWith('@g.us');
  const chatType = isGroup ? 'group' : 'private';
  const fromMe = Boolean(msg.key?.fromMe);
  const selfJid = normalizeJid(sock.user?.id) || null;
  const botAliases = new Set(
    currentBotAliases(ctx)
      .map((jid) => normalizeJid(jid) || jid)
      .filter(Boolean)
  );
  if (selfJid) botAliases.add(selfJid);
  const fromId = msg.key.participant || (fromMe ? selfJid : msg.key.remoteJid);
  const senderId = normalizeJid(fromId) || fromId || normalizeJid(msg.key.remoteJid) || msg.key.remoteJid;
  const senderDisplay = msg.pushName || lookupParticipantName(ctx, senderId) || senderId;
  rememberParticipantName(ctx, fromId, msg.pushName || '');
  rememberParticipantName(ctx, senderId, senderDisplay);

  const groupStartMs = Date.now();
  const group = isGroup
    ? await getGroupContext(ctx, chatId)
    : null;
  perf.groupMs = Date.now() - groupStartMs;
  const senderRole = isGroup ? roleFlagsForJid(group?.participantRoles, senderId) : { isAdmin: false, isSuperAdmin: false };
  const senderRef = rememberSenderRef(ctx, chatId, senderId, msg.key.participant || senderId) || 'unknown';
  const contextMsgId = normalizeContextMsgId(precomputedContextMsgId) || ensureContextMsgId(ctx, chatId, msg.key.id);
  const chatName = isGroup ? (group?.name || chatId) : chatId;

  const { contentType, message: innerMessage } = unwrapMessage(msg.message);
  if (!contentType || !innerMessage) return;
  const content = innerMessage[contentType];
  const location = extractLocationData(innerMessage);
  const locationText = location ? formatLocationText(location) : null;
  const baseText = extractText(innerMessage);
  const text = [baseText, locationText].filter(Boolean).join('\n') || null;
  const quotedStartMs = Date.now();
  const quoted: any = await extractQuoted(ctx, innerMessage, chatId, {
    allowGroupLookup: !fromMe,
    getGroupParticipantName: (cid, pid) => getGroupParticipantName(ctx, cid, pid),
  });
  perf.quotedMs = Date.now() - quotedStartMs;
  // Determine admin role for the quoted sender
  if (quoted && quoted.senderId && isGroup && group) {
    const quotedRole = roleFlagsForJid(group.participantRoles, quoted.senderId);
    quoted.senderIsAdmin = Boolean(quotedRole?.isAdmin);
    quoted.senderIsSuperAdmin = Boolean(quotedRole?.isSuperAdmin);
  }
  // Build mentionedParticipants for the quoted message for mention resolution
  let quotedMentionedParticipants: MentionedParticipant[] | null = null;
  if (quoted && Array.isArray(quoted.mentionedJids) && quoted.mentionedJids.length > 0) {
    quotedMentionedParticipants = await buildMentionedParticipants(ctx, chatId, quoted.mentionedJids, botAliases);
  }
  if (quoted) {
    quoted.mentionedParticipants = quotedMentionedParticipants;
  }
  const mentionedJidsRaw = extractMentionedJids(innerMessage);
  const mentionedJids = Array.isArray(mentionedJidsRaw)
    ? Array.from(new Set(
      mentionedJidsRaw
        .map((jid) => normalizeJid(jid) || jid)
        .filter(Boolean)
    ))
    : null;
  const mentionedParticipants = Array.isArray(mentionedJids) && mentionedJids.length > 0
    ? await buildMentionedParticipants(ctx, chatId, mentionedJids, botAliases)
    : null;
  const botMentionedByJid = Boolean(
    Array.isArray(mentionedJids)
    && mentionedJids.some((jid) => botAliases.has(normalizeJid(jid) || jid))
  );
  const botMentionTokens = Array.from(botAliases)
    .map((jid) => String(jid).split('@')[0]?.trim())
    .filter((token) => typeof token === 'string' && token.length >= 5);
  const botMentionedByText = Boolean(
    typeof text === 'string'
    && botMentionTokens.some((token) => (
      new RegExp(`(^|[^0-9A-Za-z_])@${escapeRegex(token)}(?=$|[^0-9A-Za-z_])`).test(text)
    ))
  );
  const botMentioned = botMentionedByJid || botMentionedByText;
  const quotedSenderId = normalizeJid(quoted?.senderId) || quoted?.senderId || null;
  const repliedToBot = Boolean(quotedSenderId && botAliases.has(quotedSenderId));
  if (quoted && repliedToBot) {
    quoted.fromMe = true;
  }
  // Quiz button replies (templateButtonReplyMessage with id starting "qz:")
  // must NOT be marked contextOnly — they need to trigger LLM2 for answer evaluation.
  const isQuizButtonReply = Boolean(
    msg?.message?.templateButtonReplyMessage?.selectedId?.startsWith('qz:')
  );
  // Plain-text replies to bot's interactiveMessage:
  // - If the quoted message is a quiz the bot sent → let it through (user is answering
  //   or asking something about the quiz). We track quiz message IDs in quizMessageIds.
  // - If the quoted message is a settings menu (/setting) → suppress it (contextOnly).
  //   Those interactions are handled entirely by Node.js and must not trigger the LLM.
  const isInteractiveReply = !isQuizButtonReply && repliedToBot && quoted?.type === 'interactiveMessage';
  const isQuizReply = isInteractiveReply && Boolean(quoted?.messageId && ctx.quizMessageIds.has(quoted.messageId));
  const replyToInteractive = isInteractiveReply && !isQuizReply;

  const attachments: any[] = [];
  const mediaKinds = [
    'imageMessage',
    'videoMessage',
    'audioMessage',
    'documentMessage',
    'stickerMessage',
  ];
  if (mediaKinds.includes(contentType)) {
    const mediaStartMs = Date.now();
    try {
      const mediaInfo = await saveMedia(contentType, content, msg.key.id, withTimeout);
      if (mediaInfo) attachments.push(mediaInfo);
    } catch (err) {
      logger.error({ err }, 'failed saving media');
    } finally {
      perf.mediaMs = Date.now() - mediaStartMs;
    }
  }

  // Detect slash commands for context
  // Note: Commands are dispatched by the command registry (commands/CommandRegistry.ts).
  // We still detect slash commands and send to Python for context/history
  const slashCommand = (typeof text === 'string')
    ? parseSlashCommand(text)
    : null;

  // Mark if command was handled by Node.js (for Python to skip processing)
  const commandHandled = slashCommand ? true : false;

  // Activation gate: skip sending to Python if chat is not activated
  if (config.requireActivation && !fromMe) {
    const isOwner = isOwnerJid(senderId);
    if (!isOwner) {
      const activated = ctx.repos!.activation.isChatActivated(chatId);
      if (!activated) {
        const activation = ctx.repos!.activation.getChatActivation(chatId);
        if (activation && activation.expiresAt) {
          const now = new Date();
          const expiry = new Date(activation.expiresAt);
          if (expiry <= now && !activation.expiryNotified) {
            try {
              await sock.sendMessage(chatId, {
                text: `Aktivasi sudah kadaluarsa. Gunakan /activate <kode> untuk memperpanjang.`,
              });
            } catch (e) { /* ignore */ }
            ctx.repos!.activation.markExpiryNotified(chatId);
          }
        }
        return;
      }
    }
  }

  const payload: WhatsAppMessagePayload = {
    folderPath: entry.folderPath,
    contextMsgId,
    messageId: msg.key.id,
    instanceId: config.instanceId,
    chatId,
    chatName,
    chatType,
    senderId,
    senderRef,
    senderName: fromMe ? (senderDisplay || 'LLM') : senderDisplay,
    senderIsAdmin: senderRole.isAdmin || senderRole.isSuperAdmin,
    senderIsSuperAdmin: Boolean(senderRole.isSuperAdmin),
    senderIsOwner: isOwnerJid(senderId),
    isGroup,
    botIsAdmin: Boolean(group?.botIsAdmin),
    botIsSuperAdmin: Boolean(group?.botIsSuperAdmin),
    fromMe,
    contextOnly: fromMe || contentType === 'reactionMessage' || replyToInteractive,
    triggerLlm1: false,
    timestampMs: Number(msg.messageTimestamp) * 1000,
    messageType: contentType,
    text,
    // Runtime shapes are structurally looser than the Step 09 wire contract
    // (quoted carries mutated role fields; location uses lat/long keys).
    // Reconciled in a later step. `attachments` is `any[]`, already structurally
    // assignable to `Attachment[]`, so no cast is needed here.
    quoted,
    attachments,
    mentionedJids,
    mentionedParticipants: mentionedParticipants as WhatsAppMessagePayload['mentionedParticipants'],
    botMentioned,
    repliedToBot,
    location: location as unknown as WhatsAppMessagePayload['location'],
    groupDescription: group?.description || null,
    slashCommand: slashCommand || null,
    commandHandled,
  };

  entry.ctx.forwarder!.forwardIncoming(payload);
  rememberMessage(ctx, msg, {
    chatId,
    contextMsgId,
    senderId,
    senderRef,
    senderIsAdmin: payload.senderIsAdmin,
    fromMe,
    timestampMs: payload.timestampMs,
  });

  const totalMs = Date.now() - perfStartMs;
  if (config.perfLogEnabled && totalMs >= config.perfLogThresholdMs) {
    logger.info({
      chatId,
      messageId: msg.key.id,
      messageType: contentType,
      totalMs,
      groupMs: perf.groupMs,
      quotedMs: perf.quotedMs,
      mediaMs: perf.mediaMs,
      attachmentCount: attachments.length,
      isGroup,
      fromMe,
    }, 'slow inbound message processing');
  }
}

export {
  buildMentionedParticipants,
  handleGroupParticipantsUpdate,
  handleIncomingMessage,
};
