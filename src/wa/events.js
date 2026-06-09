import logger from '../logger.js';
import config from '../config.js';
import wsClient from '../wsClient.js';
import {
  normalizeJid,
  nextContextMsgId,
  rememberSenderRef,
  rememberMessageKeyIndex,
} from '../identifiers.js';
import {
  compactParticipantJids,
  lookupParticipantName,
  roleFlagsForJid,
  fallbackParticipantLabel,
} from '../participants.js';
import {
  getCachedGroupMetadata,
  defaultGroupContext,
  getGroupContext,
  dedupeGroupJoinEvent,
  getGroupParticipantName,
} from '../groupContext.js';
import { getSock } from './connection.js';
import { isChatActivated } from '../db.js';

function makeEventMessageId(prefix) {
  const stamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${stamp}_${rand}`;
}

async function resolveParticipantLabel(chatId, participantJid) {
  const normalized = normalizeJid(participantJid) || participantJid;
  if (!normalized) return 'unknown';
  const candidates = Array.from(new Set([participantJid, normalized].filter(Boolean)));
  for (const candidate of candidates) {
    const fromCache = lookupParticipantName(candidate);
    if (fromCache) return fromCache;
  }
  if (chatId?.endsWith('@g.us')) {
    for (const candidate of candidates) {
      const fromGroup = await getGroupParticipantName(chatId, candidate);
      if (fromGroup) return fromGroup;
    }
  }
  return fallbackParticipantLabel(normalized);
}

async function emitGroupJoinContextEvent({
  chatId,
  action,
  participants,
  actorId = null,
  timestampMs = Date.now(),
  messageId = null,
  messageKey = null,
  source = 'group-participants.update',
}) {
  const normalizedParticipants = compactParticipantJids(participants);
  if (!chatId || !chatId.endsWith('@g.us') || normalizedParticipants.length === 0) return;
  if (!dedupeGroupJoinEvent(chatId, normalizedParticipants, action, timestampMs)) return;

  if (config.requireActivation && !isChatActivated(chatId)) return;

  const group = await getGroupContext(chatId, { forceRefresh: true });
  const labels = await Promise.all(
    normalizedParticipants.map((participantJid) => resolveParticipantLabel(chatId, participantJid))
  );
  const mentionedParticipants = normalizedParticipants.map((participantJid, idx) => {
    const senderRef = rememberSenderRef(chatId, participantJid, participantJid) || null;
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
    ? await resolveParticipantLabel(chatId, normalizedActorId)
    : null;
  const actorSenderId = normalizedActorId || 'group-system@wazzap.local';
  const actorSenderRef = rememberSenderRef(chatId, actorSenderId, actorSenderId) || 'unknown';
  const actorRole = roleFlagsForJid(group?.participantRoles, actorSenderId);
  const hasAnchorKey = Boolean(messageKey?.id);
  const contextMsgId = hasAnchorKey ? nextContextMsgId(chatId) : null;
  const normalizedTimestampMs = Number(timestampMs) || Date.now();
  const resolvedMessageId = messageId || makeEventMessageId('group_join');

  if (contextMsgId) {
    rememberMessageKeyIndex({
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

  const payload = {
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

  wsClient.send({ type: 'incoming_message', payload });
}

function emitBotActionContextEvent({
  chatId,
  action,
  text,
  result = null,
}) {
  const sock = getSock();
  if (!sock || !chatId || !text) return;

  if (config.requireActivation && !isChatActivated(chatId)) return;

  const isGroup = chatId.endsWith('@g.us');
  const group = isGroup
    ? (getCachedGroupMetadata(chatId) || defaultGroupContext(chatId))
    : null;
  const senderId = normalizeJid(sock.user?.id) || 'bot@wazzap.local';
  const senderRef = rememberSenderRef(chatId, senderId, senderId) || 'unknown';
  const payload = {
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

  wsClient.send({ type: 'incoming_message', payload });
}

function emitBotRoleChangeEvent({
  chatId,
  action,
  actorId = null,
}) {
  const sock = getSock();
  if (!sock || !chatId) return;

  if (config.requireActivation && !isChatActivated(chatId)) return;

  const group = getCachedGroupMetadata(chatId) || defaultGroupContext(chatId);
  const senderId = 'group-system@wazzap.local';
  const senderRef = rememberSenderRef(chatId, senderId, senderId) || 'unknown';
  const normalizedActorId = normalizeJid(actorId) || null;

  const payload = {
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

  wsClient.send({ type: 'incoming_message', payload });
  logger.info({ chatId, action }, 'emitted bot role change event');
}

export {
  makeEventMessageId,
  resolveParticipantLabel,
  emitGroupJoinContextEvent,
  emitBotActionContextEvent,
  emitBotRoleChangeEvent,
};
