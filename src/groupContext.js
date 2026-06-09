import { WAMessageStubType } from 'baileys';
import logger from './logger.js';
import config from './config.js';
import {
  groupMetadataCache,
  groupJoinDedupCache,
  GROUP_METADATA_TTL_MS,
  GROUP_JOIN_DEDUP_TTL_MS,
  GROUP_JOIN_STUB_TYPES,
  cacheSetBounded,
} from './caches.js';
import {
  normalizeJid,
} from './identifiers.js';
import {
  compactParticipantJids,
  hydrateGroupParticipantCaches,
  extractParticipantAliases,
  buildParticipantRoleMap,
  roleFlagsForJid,
  participantDisplayName,
  rememberParticipantName,
  lookupParticipantName,
  groupParticipantKey,
} from './participants.js';

let getSock = () => null;

function setSockAccessor(fn) {
  getSock = fn;
}

function parseGroupDescription(rawDescription) {
  if (typeof rawDescription !== 'string' || !rawDescription.trim()) {
    return { description: null };
  }
  const cleaned = rawDescription
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    description: cleaned || null,
  };
}

function pickGroupDescription(meta) {
  const candidates = [
    meta?.desc,
    meta?.description,
    meta?.descText,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function currentBotAliases() {
  const sock = getSock();
  if (!sock?.user) return [];
  const aliases = extractParticipantAliases([
    sock.user.id,
    sock.user.jid,
    sock.user.lid,
    sock.user.phoneNumber,
  ]);
  if (aliases.length > 0) return aliases;
  const normalized = normalizeJid(sock.user.id);
  return normalized ? [normalized] : [];
}

function normalizeGroupMetadata(meta, jid) {
  const name = meta?.subject || jid;
  const rawDescription = pickGroupDescription(meta);
  const { description } = parseGroupDescription(rawDescription || '');
  const participantRoles = buildParticipantRoleMap(meta);
  const participants = compactParticipantJids(Array.isArray(meta?.participants) ? meta.participants : []);
  const botAliases = currentBotAliases();
  let botIsAdmin = false;
  let botIsSuperAdmin = false;
  for (const alias of botAliases) {
    const flags = roleFlagsForJid(participantRoles, alias);
    if (flags.isSuperAdmin) botIsSuperAdmin = true;
    if (flags.isAdmin || flags.isSuperAdmin) botIsAdmin = true;
  }
  return {
    name,
    description,
    botIsAdmin,
    botIsSuperAdmin,
    participantRoles,
    participants,
  };
}

function defaultGroupContext(jid) {
  return {
    name: jid,
    description: null,
    botIsAdmin: false,
    botIsSuperAdmin: false,
    participantRoles: {},
    participants: [],
  };
}

function getCachedGroupMetadata(jid) {
  const cached = groupMetadataCache.get(jid);
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > GROUP_METADATA_TTL_MS) {
    groupMetadataCache.delete(jid);
    return null;
  }
  return cached.value;
}

function rememberGroupMetadata(jid, value) {
  cacheSetBounded(groupMetadataCache, jid, {
    fetchedAt: Date.now(),
    value,
  }, 2000);
}

function invalidateGroupMetadata(jid) {
  if (!jid) return;
  groupMetadataCache.delete(jid);
}

async function getGroupContext(jid, { forceRefresh = false } = {}) {
  if (!jid) return defaultGroupContext(jid);
  const sock = getSock();
  if (!sock) return defaultGroupContext(jid);

  if (!forceRefresh) {
    const cached = getCachedGroupMetadata(jid);
    if (cached) return cached;
  }

  try {
    const { withTimeout } = await import('./wa/index.js');
    const meta = await withTimeout(
      sock.groupMetadata(jid),
      config.groupMetadataTimeoutMs,
      `groupMetadata(${jid})`
    );
    hydrateGroupParticipantCaches(jid, meta?.participants);
    const normalized = normalizeGroupMetadata(meta, jid);
    rememberGroupMetadata(jid, normalized);
    return normalized;
  } catch (err) {
    logger.warn({
      err,
      jid,
      timeoutMs: config.groupMetadataTimeoutMs,
    }, 'failed to fetch group metadata');
    const cached = getCachedGroupMetadata(jid);
    if (cached) return cached;
    return defaultGroupContext(jid);
  }
}

async function getGroupParticipantName(chatId, participantJid) {
  const sock = getSock();
  if (!sock || !chatId || !participantJid) return null;
  const key = groupParticipantKey(chatId, participantJid);
  const { groupParticipantNameCache } = await import('./caches.js');
  const cached = groupParticipantNameCache.get(key);
  if (cached) return cached;

  const fallback = lookupParticipantName(participantJid);
  if (fallback) {
    cacheSetBounded(groupParticipantNameCache, key, fallback);
    return fallback;
  }

  const hadCachedMetadata = Boolean(getCachedGroupMetadata(chatId));
  await getGroupContext(chatId);
  let resolved = lookupParticipantName(participantJid);

  if (!resolved && hadCachedMetadata) {
    await getGroupContext(chatId, { forceRefresh: true });
    resolved = lookupParticipantName(participantJid);
  }

  if (resolved) {
    cacheSetBounded(groupParticipantNameCache, key, resolved);
  }
  return resolved || null;
}

function normalizeGroupJoinAction(action) {
  const normalized = typeof action === 'string' ? action.toLowerCase() : '';
  if (!normalized) return 'join';
  if (normalized === 'add' || normalized.includes('_add')) return 'add';
  if (normalized === 'invite' || normalized.includes('invite')) return 'invite';
  if (normalized === 'approve' || normalized === 'accept' || normalized.includes('approve') || normalized.includes('accept')) {
    return 'approve';
  }
  if (normalized === 'join' || normalized.includes('join')) return 'join';
  return normalized;
}

function dedupeGroupJoinEvent(chatId, participants, action, timestampMs) {
  const ts = Number(timestampMs) || Date.now();
  const normalizedAction = normalizeGroupJoinAction(action);
  const normalizedParticipants = compactParticipantJids(participants).sort();
  const key = `${chatId}::${normalizedAction}::${normalizedParticipants.join(',')}`;
  const lastSeen = groupJoinDedupCache.get(key);
  if (lastSeen && ts - lastSeen < GROUP_JOIN_DEDUP_TTL_MS) {
    return false;
  }
  cacheSetBounded(groupJoinDedupCache, key, ts, 2000);
  return true;
}

function stubActionName(stubType) {
  if (typeof stubType !== 'number') return 'join';
  const enumName = WAMessageStubType[stubType];
  if (typeof enumName !== 'string' || !enumName) return 'join';
  return enumName.toLowerCase();
}

function parseGroupJoinStub(msg) {
  const chatId = msg?.key?.remoteJid;
  if (!chatId || !chatId.endsWith('@g.us')) return null;
  const stubType = msg?.messageStubType;
  if (!GROUP_JOIN_STUB_TYPES.has(stubType)) return null;

  const rawParams = Array.isArray(msg?.messageStubParameters)
    ? msg.messageStubParameters
    : [];
  const parsedFromParams = compactParticipantJids(rawParams);
  const participants = parsedFromParams.length > 0
    ? parsedFromParams
    : compactParticipantJids([msg?.participant]);

  if (participants.length === 0) return null;

  const actorId = compactParticipantJids([
    msg?.key?.participantAlt,
    msg?.participantPn,
    msg?.key?.participant,
    msg?.participant,
  ])[0] || null;
  const timestampMs = Number(msg?.messageTimestamp) > 0
    ? Number(msg.messageTimestamp) * 1000
    : Date.now();
  return {
    chatId,
    action: normalizeGroupJoinAction(stubActionName(stubType)),
    participants,
    actorId,
    timestampMs,
    messageId: msg?.key?.id || null,
    messageKey: msg?.key?.id ? { ...msg.key } : null,
    source: 'messages.upsert.stub',
  };
}

export {
  setSockAccessor,
  parseGroupDescription,
  pickGroupDescription,
  currentBotAliases,
  normalizeGroupMetadata,
  defaultGroupContext,
  getCachedGroupMetadata,
  rememberGroupMetadata,
  invalidateGroupMetadata,
  getGroupContext,
  getGroupParticipantName,
  normalizeGroupJoinAction,
  dedupeGroupJoinEvent,
  stubActionName,
  parseGroupJoinStub,
};
