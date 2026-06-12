import type { WAMessageKey } from 'baileys';
import logger from '../logger.js';
import config from '../config.js';
import {
  normalizeJid,
  nextContextMsgId,
  rememberSenderRef,
  rememberMessageKeyIndex,
} from './domain/identifiers.js';
import {
  compactParticipantJids,
  lookupParticipantName,
  roleFlagsForJid,
  fallbackParticipantLabel,
} from './domain/participants.js';
import {
  getCachedGroupMetadata,
  defaultGroupContext,
  getGroupContext,
  dedupeGroupJoinEvent,
  getGroupParticipantName,
} from './domain/groupContext.js';
import type { AccountContext } from '../account/accountContext.js';
import type { WhatsAppMessagePayload } from '../protocol/types.js';

/** Arguments accepted by {@link emitGroupJoinContextEvent}. */
interface GroupJoinEventArgs {
  chatId?: string | null;
  action?: string;
  participants?: unknown;
  actorId?: string | null;
  timestampMs?: number;
  messageId?: string | null;
  messageKey?: WAMessageKey | null;
  source?: string;
}

function makeEventMessageId(prefix: string): string {
  const stamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${stamp}_${rand}`;
}

async function resolveParticipantLabel(
  ctx: AccountContext,
  chatId: string | null | undefined,
  participantJid: string,
): Promise<string> {
  const normalized = normalizeJid(participantJid) || participantJid;
  if (!normalized) return 'unknown';
  const candidates = Array.from(new Set([participantJid, normalized].filter(Boolean)));
  for (const candidate of candidates) {
    const fromCache = lookupParticipantName(ctx, candidate);
    if (fromCache) return fromCache;
  }
  if (chatId?.endsWith('@g.us')) {
    for (const candidate of candidates) {
      const fromGroup = await getGroupParticipantName(ctx, chatId, candidate);
      if (fromGroup) return fromGroup;
    }
  }
  return fallbackParticipantLabel(normalized);
}

async function emitGroupJoinContextEvent(ctx: AccountContext, {
  chatId,
  action,
  participants,
  actorId = null,
  timestampMs = Date.now(),
  messageId = null,
  messageKey = null,
  source = 'group-participants.update',
}: GroupJoinEventArgs): Promise<void> {
  const normalizedParticipants = compactParticipantJids(participants);
  if (!chatId || !chatId.endsWith('@g.us') || normalizedParticipants.length === 0) return;
  if (!dedupeGroupJoinEvent(ctx, chatId, normalizedParticipants, action, timestampMs)) return;

  if (config.requireActivation && !ctx.repos!.activation.isChatActivated(chatId)) return;

  const group = await getGroupContext(ctx, chatId, { forceRefresh: true });
  const labels = await Promise.all(
    normalizedParticipants.map((participantJid) => resolveParticipantLabel(ctx, chatId, participantJid))
  );
  const mentionedParticipants = normalizedParticipants.map((participantJid, idx) => {
    const senderRef = rememberSenderRef(ctx, chatId, participantJid, participantJid) || null;
    const name = labels[idx] || fallbackParticipantLabel(participantJid);
    return {
      jid: participantJid,
      senderRef,
      name,
      isBot: false,
    };
  });
  const uniqueParticipantLabels = Array.from(new Set(
    mentionedParticipants
      .map((item) => {
        const senderRef = typeof item.senderRef === 'string' ? item.senderRef.trim() : '';
        if (senderRef) return `${item.name} (${senderRef})`;
        return item.name;
      })
      .filter(Boolean)
  ));
  const normalizedActorId = normalizeJid(actorId) || null;
  const actorName = normalizedActorId
    ? await resolveParticipantLabel(ctx, chatId, normalizedActorId)
    : null;
  const actorSenderId = normalizedActorId || 'group-system@wazzap.local';
  const actorSenderRef = rememberSenderRef(ctx, chatId, actorSenderId, actorSenderId) || 'unknown';
  const actorRole = roleFlagsForJid(group?.participantRoles, actorSenderId);
  const hasAnchorKey = Boolean(messageKey?.id);
  const contextMsgId = hasAnchorKey ? nextContextMsgId(ctx, chatId) : null;
  const normalizedTimestampMs = Number(timestampMs) || Date.now();
  const resolvedMessageId = messageId || makeEventMessageId('group_join');

  if (contextMsgId) {
    rememberMessageKeyIndex(ctx, {
      chatId,
      contextMsgId,
      rawKey: messageKey,
      senderId: actorSenderId,
      senderRef: actorSenderRef,
      senderIsAdmin: actorRole.isAdmin || actorRole.isSuperAdmin,
      fromMe: false,
      timestampMs: normalizedTimestampMs,
    });
  }

  const joinedText = uniqueParticipantLabels.length === 1
    ? `${uniqueParticipantLabels[0]} joined the group.`
    : `New members joined the group: ${uniqueParticipantLabels.join(', ')}.`;
  const byText = actorName ? ` Added by ${actorName}.` : '';
  const text = `Group update: ${joinedText}${byText}`;

  const payload: Record<string, any> = {
    messageId: resolvedMessageId,
    instanceId: config.instanceId,
    chatId,
    chatName: group.name || chatId,
    chatType: 'group',
    senderId: actorSenderId,
    senderRef: actorSenderRef,
    senderName: actorName || 'Group System',
    senderIsAdmin: actorRole.isAdmin || actorRole.isSuperAdmin,
    isGroup: true,
    botIsAdmin: Boolean(group?.botIsAdmin),
    botIsSuperAdmin: Boolean(group?.botIsSuperAdmin),
    fromMe: false,
    timestampMs: normalizedTimestampMs,
    messageType: 'groupParticipantsUpdate',
    text,
    quoted: null,
    attachments: [],
    mentionedJids: normalizedParticipants,
    mentionedParticipants,
    location: null,
    contextOnly: true,
    triggerLlm1: true,
    groupDescription: group.description,
    groupEvent: {
      action: action || 'join',
      participants: normalizedParticipants,
      actorId: normalizedActorId,
      actorName,
      source,
    },
  };
  if (contextMsgId) payload.contextMsgId = contextMsgId;

  // Step 18: route through the forwarder (stamps folderPath = entry.folderPath).
  ctx.forwarder!.forwardIncoming(payload as unknown as WhatsAppMessagePayload);
}

function emitBotActionContextEvent(ctx: AccountContext, {
  chatId,
  action,
  text,
  result = null,
}: {
  chatId: string;
  action: string;
  text: string;
  result?: unknown;
}): void {
  const sock = ctx.sock;
  if (!sock || !chatId || !text) return;

  if (config.requireActivation && !ctx.repos!.activation.isChatActivated(chatId)) return;

  const isGroup = chatId.endsWith('@g.us');
  const group = isGroup
    ? (getCachedGroupMetadata(ctx, chatId) || defaultGroupContext(chatId))
    : null;
  const senderId = normalizeJid(sock.user?.id) || 'bot@wazzap.local';
  const senderRef = rememberSenderRef(ctx, chatId, senderId, senderId) || 'unknown';
  const payload: Record<string, any> = {
    messageId: makeEventMessageId('action_log'),
    instanceId: config.instanceId,
    chatId,
    chatName: isGroup ? (group?.name || chatId) : chatId,
    chatType: isGroup ? 'group' : 'private',
    senderId,
    senderRef,
    senderName: sock.user?.name || 'LLM',
    senderIsAdmin: Boolean(group?.botIsAdmin),
    isGroup,
    botIsAdmin: Boolean(group?.botIsAdmin),
    botIsSuperAdmin: Boolean(group?.botIsSuperAdmin),
    fromMe: true,
    contextOnly: true,
    triggerLlm1: false,
    timestampMs: Date.now(),
    messageType: 'actionLog',
    text,
    quoted: null,
    attachments: [],
    mentionedJids: null,
    mentionedParticipants: null,
    location: null,
    groupDescription: group?.description || null,
    actionLog: {
      action,
      result,
    },
  };

  // Step 18: route through the forwarder (stamps folderPath = entry.folderPath).
  ctx.forwarder!.forwardIncoming(payload as unknown as WhatsAppMessagePayload);
}

function emitBotRoleChangeEvent(ctx: AccountContext, {
  chatId,
  action,
  actorId = null,
}: {
  chatId: string;
  action: string;
  actorId?: string | null;
}): void {
  const sock = ctx.sock;
  if (!sock || !chatId) return;

  if (config.requireActivation && !ctx.repos!.activation.isChatActivated(chatId)) return;

  const group = getCachedGroupMetadata(ctx, chatId) || defaultGroupContext(chatId);
  const senderId = 'group-system@wazzap.local';
  const senderRef = rememberSenderRef(ctx, chatId, senderId, senderId) || 'unknown';
  const normalizedActorId = normalizeJid(actorId) || null;

  const payload: Record<string, any> = {
    messageId: makeEventMessageId('bot_role_change'),
    instanceId: config.instanceId,
    chatId,
    chatName: group?.name || chatId,
    chatType: 'group',
    senderId,
    senderRef,
    senderName: 'Group System',
    senderIsAdmin: false,
    isGroup: true,
    botIsAdmin: action === 'promote',
    botIsSuperAdmin: false,
    fromMe: false,
    contextOnly: true,
    triggerLlm1: false,
    timestampMs: Date.now(),
    messageType: 'botRoleChange',
    text: `Bot role changed: ${action}`,
    quoted: null,
    attachments: [],
    mentionedJids: null,
    mentionedParticipants: null,
    location: null,
    groupDescription: group?.description || null,
    groupEvent: {
      action,
      actorId: normalizedActorId,
      source: 'group-participants.update',
    },
  };

  // Step 18: route through the forwarder (stamps folderPath = entry.folderPath).
  ctx.forwarder!.forwardIncoming(payload as unknown as WhatsAppMessagePayload);
  logger.info({ chatId, action }, 'emitted bot role change event');
}

export {
  makeEventMessageId,
  resolveParticipantLabel,
  emitGroupJoinContextEvent,
  emitBotActionContextEvent,
  emitBotRoleChangeEvent,
};
