import {
  getContentType,
  normalizeMessageContent,
} from 'baileys';
import type { proto } from 'baileys';
import logger from '../../logger.js';
import {
  normalizeJid,
  findContextMsgIdByMessageId,
  rememberSenderRef,
} from './identifiers.js';
import {
  rememberParticipantName,
  lookupParticipantName,
} from './participants.js';
import type { AccountContext } from '../../account/accountContext.js';

/**
 * Result of unwrapping a raw WhatsApp message envelope down to its concrete
 * content node plus the Baileys content-type discriminator.
 */
interface UnwrappedMessage {
  contentType: keyof proto.IMessage | null | undefined;
  message: proto.IMessage | null | undefined;
}

/**
 * Normalized location payload extracted from a live or static location message.
 */
interface LocationData {
  degreesLatitude: number;
  degreesLongitude: number;
  accuracy?: number | null;
  caption?: string | null;
  name?: string | null;
  address?: string | null;
  isLive: boolean;
}

/**
 * Options controlling quoted-message resolution.
 */
interface ExtractQuotedOptions {
  allowGroupLookup?: boolean;
  getGroupParticipantName?: ((chatId: string, senderId: string) => Promise<string | null>) | null;
}

/**
 * Normalized representation of a quoted (replied-to) message.
 */
interface QuotedMessage {
  messageId: string | null | undefined;
  contextMsgId: string | null;
  senderId: string | null;
  senderName: string | null;
  senderRef: string | null;
  mentionedJids: string[];
  text: string | null;
  type: keyof proto.IMessage | null | undefined;
  location: LocationData | null;
}

function unwrapMessage(message: proto.IMessage | null | undefined): UnwrappedMessage {
  if (!message) return { contentType: null, message: null };
  let normalized = normalizeMessageContent(message);

  // Baileys doesn't unwrap lottieStickerMessage, so we handle it here.
  // Structure: { lottieStickerMessage: { message: { stickerMessage: { ... } } } }
  // The inner stickerMessage already has isLottie=true, so the marker is preserved.
  const lottieInner = (normalized as { lottieStickerMessage?: { message?: proto.IMessage } } | undefined)
    ?.lottieStickerMessage?.message;
  if (lottieInner) {
    normalized = normalizeMessageContent(lottieInner) || lottieInner;
  }

  const contentType = normalized ? getContentType(normalized) : null;
  return { contentType, message: normalized };
}

function extractContextInfo(message: proto.IMessage | null | undefined): proto.IContextInfo | null | undefined {
  if (!message) return undefined;
  const contentType = getContentType(message);
  const candidate: any = contentType ? message[contentType] : undefined;
  if (candidate?.contextInfo) return candidate.contextInfo;
  for (const value of Object.values(message) as unknown[]) {
    if (value && typeof value === 'object' && 'contextInfo' in value) {
      return (value as { contextInfo?: proto.IContextInfo | null }).contextInfo;
    }
  }
  return undefined;
}

function extractMentionedJids(message: proto.IMessage | null | undefined): string[] | null {
  const ctx = extractContextInfo(message);
  const mentions = ctx?.mentionedJid;
  if (!mentions || mentions.length === 0) return null;
  return Array.from(new Set(mentions));
}

function parseVcardPhones(vcard: string | null | undefined): string[] {
  if (!vcard) return [];
  const lines = vcard.split(/\r?\n/);
  const phones: string[] = [];
  for (const line of lines) {
    const match = line.match(/^TEL[^:]*:(.+)$/i);
    if (match?.[1]) phones.push(match[1].trim());
  }
  return phones;
}

function extractContactPlaceholder(message: proto.IMessage | null | undefined): string | null {
  if (message?.contactMessage) {
    const { displayName, vcard } = message.contactMessage;
    const phones = parseVcardPhones(vcard);
    const label = [displayName, phones[0]].filter(Boolean).join(', ');
    return label ? `<contact: ${label}>` : '<contact>';
  }
  const contacts = message?.contactsArrayMessage?.contacts;
  if (contacts && contacts.length > 0) {
    const first = contacts[0];
    const name = first?.displayName;
    const phones = parseVcardPhones(first?.vcard || '');
    const label = [name, phones[0]].filter(Boolean).join(', ');
    const suffix = contacts.length > 1 ? ` +${contacts.length - 1} more` : '';
    return label ? `<contacts: ${label}${suffix}>` : `<contacts: ${contacts.length}>`;
  }
  return null;
}

function extractLocationData(message: proto.IMessage | null | undefined): LocationData | null {
  if (!message) return null;
  const live = message.liveLocationMessage;
  if (live?.degreesLatitude != null && live?.degreesLongitude != null) {
    return {
      degreesLatitude: Number(live.degreesLatitude),
      degreesLongitude: Number(live.degreesLongitude),
      accuracy: live.accuracyInMeters,
      caption: live.caption,
      isLive: true,
    };
  }
  const location = message.locationMessage;
  if (location?.degreesLatitude != null && location?.degreesLongitude != null) {
    return {
      degreesLatitude: Number(location.degreesLatitude),
      degreesLongitude: Number(location.degreesLongitude),
      accuracy: location.accuracyInMeters,
      name: location.name,
      address: location.address,
      caption: location.comment,
      isLive: Boolean(location.isLive),
    };
  }
  return null;
}

function formatLocationText(loc: LocationData): string {
  const parts: string[] = [];
  if (loc.name) parts.push(loc.name);
  if (loc.address && loc.address !== loc.name) parts.push(loc.address);
  const coords = Number.isFinite(loc.degreesLatitude) && Number.isFinite(loc.degreesLongitude)
    ? `${loc.degreesLatitude.toFixed(5)}, ${loc.degreesLongitude.toFixed(5)}`
    : null;
  if (coords) parts.push(coords);
  if (loc.caption) parts.push(loc.caption);
  return parts.length ? `📍 ${parts.join(' | ')}` : '📍 Location';
}

function extractInteractiveText(message: proto.IMessage | null | undefined): string | null {
  if (!message) return null;
  const btn: any = message.buttonsResponseMessage;
  if (btn) return btn.selectedDisplayText || btn.selectedButtonId || btn.selectedId || null;

  const tmpl: any = message.templateButtonReplyMessage;
  if (tmpl) return tmpl.selectedDisplayText || tmpl.selectedId || String(tmpl.selectedIndex ?? '');

  const list: any = message.listResponseMessage;
  if (list) {
    return (
      list.title ||
      list.description ||
      list.singleSelectReply?.title ||
      list.singleSelectReply?.description ||
      list.singleSelectReply?.selectedRowId ||
      null
    );
  }

  const interactive: any = message.interactiveResponseMessage;
  if (interactive?.nativeFlowResponseMessage?.paramsJson) {
    try {
      const parsed = JSON.parse(interactive.nativeFlowResponseMessage.paramsJson);
      if (typeof parsed === 'string') return parsed;
      if (parsed?.id) return parsed.id;
      if (parsed?.selection?.title) return parsed.selection.title;
      if (parsed?.selection?.id) return parsed.selection.id;
      if (parsed?.name) return parsed.name;
    } catch (err) {
      logger.debug({ err }, 'failed to parse nativeFlowResponse paramsJson');
    }
    return interactive.nativeFlowResponseMessage.paramsJson;
  }
  if (interactive?.body) return interactive.body;

  return null;
}

function extractMediaPlaceholder(message: proto.IMessage | null | undefined): string | null {
  if (!message) return null;
  if (message.imageMessage) return '<media:image>';
  if (message.videoMessage) return '<media:video>';
  if (message.audioMessage) return '<media:audio>';
  if (message.documentMessage) return '<media:document>';
  if (message.stickerMessage) return '<media:sticker>';
  if (message.interactiveMessage) return '<media:interactive>';
  return null;
}

function extractText(message: proto.IMessage | null | undefined): string | null {
  if (!message) return null;

  const text = message.conversation?.trim();
  if (text) return text;

  const extended = message.extendedTextMessage?.text?.trim();
  if (extended) return extended;

  const interactive = extractInteractiveText(message);
  if (interactive) return interactive;

  const interactiveBody = message.interactiveMessage?.body?.text?.trim();
  if (interactiveBody) return interactiveBody;

  const caption =
    message.imageMessage?.caption || message.videoMessage?.caption || message.documentMessage?.caption;
  if (caption) return caption;

  const reaction = message.reactionMessage?.text;
  if (reaction) return `react:${reaction}`;

  const contact = extractContactPlaceholder(message);
  if (contact) return contact;

  const mediaPlaceholder = extractMediaPlaceholder(message);
  if (mediaPlaceholder) return mediaPlaceholder;

  return null;
}

async function extractQuoted(
  ctx: AccountContext,
  messageOrContent: proto.IMessage | null | undefined,
  chatId: string | null | undefined,
  { allowGroupLookup = true, getGroupParticipantName = null }: ExtractQuotedOptions = {},
): Promise<QuotedMessage | null> {
  const info = extractContextInfo(messageOrContent);
  if (!info || !info.quotedMessage) return null;
  const { contentType: qType, message: qMsg } = unwrapMessage(info.quotedMessage);
  if (!qMsg) return null;
  const location = extractLocationData(qMsg);
  const locationText = location ? formatLocationText(location) : null;
  const qText = extractText(qMsg);
  const text = [qText, locationText].filter(Boolean).join('\n') || null;
  // Extract mentionedJids from the quoted sub-message for mention resolution
  const qMentionedJids = extractMentionedJids(qMsg) || [];
  let senderId = info.participant ? normalizeJid(info.participant) : null;
  let senderName: string | null = null;
  const quotedMsg = info.stanzaId ? ctx.messageCache.get(info.stanzaId) : null;

  if (quotedMsg) {
    const quotedFromId = quotedMsg.key?.participant || quotedMsg.key?.remoteJid;
    if (!senderId && quotedFromId) {
      senderId = normalizeJid(quotedFromId);
    }
    const quotedPushName = quotedMsg.pushName;
    if (typeof quotedPushName === 'string' && quotedPushName.trim()) {
      senderName = quotedPushName.trim();
      if (senderId) rememberParticipantName(ctx, senderId, senderName);
      if (quotedFromId) rememberParticipantName(ctx, quotedFromId, senderName);
    }
  }

  if (!senderName && senderId) senderName = lookupParticipantName(ctx, senderId);
  if (!senderName && info.participant) senderName = lookupParticipantName(ctx, info.participant);
  if (allowGroupLookup && !senderName && chatId?.endsWith('@g.us') && senderId && getGroupParticipantName) {
    senderName = await getGroupParticipantName(chatId, senderId);
  }
  const contextMsgId = info.stanzaId ? findContextMsgIdByMessageId(ctx, chatId, info.stanzaId) : null;

  // Resolve senderRef for the quoted sender
  const quotedSenderRef = senderId ? rememberSenderRef(ctx, chatId, senderId, info.participant || senderId) : null;

  return {
    messageId: info.stanzaId,
    contextMsgId,
    senderId,
    senderName: senderName || senderId,
    senderRef: quotedSenderRef,
    mentionedJids: qMentionedJids,
    text,
    type: qType,
    location,
  };
}

export {
  unwrapMessage,
  extractContextInfo,
  extractMentionedJids,
  parseVcardPhones,
  extractContactPlaceholder,
  extractLocationData,
  formatLocationText,
  extractInteractiveText,
  extractMediaPlaceholder,
  extractText,
  extractQuoted,
};
