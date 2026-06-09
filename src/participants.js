import config from './config.js';
import {
  participantNameCache,
  groupParticipantNameCache,
  cacheSetBounded,
} from './caches.js';
import {
  normalizeJid,
  normalizeContextMsgId,
  rememberSenderRef,
} from './identifiers.js';

function toJidCandidate(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.includes('@')) return trimmed;

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length >= 5) return `${digits}@s.whatsapp.net`;
  return null;
}

function choosePreferredParticipantJid(jids) {
  if (!Array.isArray(jids) || jids.length === 0) return null;
  const unique = Array.from(new Set(jids.filter((jid) => typeof jid === 'string' && jid.trim())));
  if (unique.length === 0) return null;
  const pn = unique.find((jid) => jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us') || jid.endsWith('@lid'));
  return pn || unique[0];
}

function extractParticipantAliases(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    const normalized = [];
    for (const item of value) {
      const aliases = extractParticipantAliases(item);
      normalized.push(...aliases);
    }
    return Array.from(new Set(normalized));
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return extractParticipantAliases(JSON.parse(trimmed));
      } catch {
        return [];
      }
    }
    const parsed = toJidCandidate(trimmed);
    if (!parsed) return [];
    const cleaned = normalizeJid(parsed) || parsed;
    return [cleaned];
  }

  if (typeof value !== 'object') return [];
  const candidates = [
    value.phoneNumber,
    value.pn,
    value.id,
    value.jid,
    value.lid,
    value.participant,
  ];

  const normalized = [];
  for (const candidate of candidates) {
    const parsed = toJidCandidate(candidate);
    if (!parsed) continue;
    normalized.push(normalizeJid(parsed) || parsed);
  }
  return Array.from(new Set(normalized));
}

function extractParticipantJids(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    const normalized = [];
    for (const item of value) {
      const aliases = extractParticipantAliases(item);
      const preferred = choosePreferredParticipantJid(aliases);
      if (preferred) normalized.push(preferred);
    }
    return Array.from(new Set(normalized));
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return extractParticipantJids(JSON.parse(trimmed));
      } catch {
        return [];
      }
    }
    const aliases = extractParticipantAliases(trimmed);
    const preferred = choosePreferredParticipantJid(aliases);
    return preferred ? [preferred] : [];
  }

  const aliases = extractParticipantAliases(value);
  const preferred = choosePreferredParticipantJid(aliases);
  return preferred ? [preferred] : [];
}

function compactParticipantJids(participants) {
  if (!Array.isArray(participants)) return [];
  const normalized = [];
  for (const participant of participants) {
    const candidates = extractParticipantJids(participant);
    for (const jid of candidates) {
      const cleaned = normalizeJid(jid) || jid;
      normalized.push(cleaned);
    }
  }
  return Array.from(new Set(normalized));
}

function rememberParticipantName(jid, name) {
  if (!jid || typeof jid !== 'string') return;
  if (!name || typeof name !== 'string') return;
  const cleaned = name.trim();
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return;
  if (!cleaned) return;

  cacheSetBounded(participantNameCache, jid, cleaned);
  const normalized = normalizeJid(jid);
  if (normalized) cacheSetBounded(participantNameCache, normalized, cleaned);
}

function lookupParticipantName(jid) {
  if (!jid || typeof jid !== 'string') return null;
  const direct = participantNameCache.get(jid);
  if (direct) return direct;
  const normalized = normalizeJid(jid);
  if (!normalized) return null;
  return participantNameCache.get(normalized) || null;
}

function groupParticipantKey(chatId, participantJid) {
  const normalized = normalizeJid(participantJid) || participantJid;
  return `${chatId}::${normalized}`;
}

function participantDisplayName(participant) {
  if (!participant || typeof participant !== 'object') return null;
  const candidates = [
    participant.name,
    participant.notify,
    participant.pushName,
    participant.verifiedName,
    participant.vname,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const cleaned = candidate.trim();
    if (!/[\p{L}\p{N}]/u.test(cleaned)) continue;
    if (cleaned) return cleaned;
  }
  return null;
}

function hydrateGroupParticipantCaches(chatId, participants) {
  if (!chatId || !Array.isArray(participants)) return;
  for (const participant of participants) {
    const aliases = extractParticipantAliases(participant);
    const preferred = choosePreferredParticipantJid(aliases);
    const name = participantDisplayName(participant);
    if (name) {
      for (const alias of aliases) {
        rememberParticipantName(alias, name);
        cacheSetBounded(groupParticipantNameCache, groupParticipantKey(chatId, alias), name);
      }
    }
    for (const alias of aliases) {
      rememberSenderRef(chatId, alias, preferred || alias);
    }
  }
}

function participantRoleFlags(participant) {
  const adminRole = typeof participant?.admin === 'string' ? participant.admin.toLowerCase() : '';
  const isSuperAdmin = adminRole === 'superadmin';
  const isAdmin = isSuperAdmin || adminRole === 'admin';
  return { isAdmin, isSuperAdmin };
}

function buildParticipantRoleMap(meta) {
  const roleMap = {};
  const participants = Array.isArray(meta?.participants) ? meta.participants : [];
  for (const participant of participants) {
    const roleFlags = participantRoleFlags(participant);
    const aliases = extractParticipantAliases(participant);
    for (const alias of aliases) {
      if (!alias) continue;
      roleMap[alias] = roleFlags;
    }
  }
  return roleMap;
}

function roleFlagsForJid(participantRoles, jid) {
  if (!participantRoles || typeof participantRoles !== 'object') {
    return { isAdmin: false, isSuperAdmin: false };
  }
  const normalized = normalizeJid(jid) || jid;
  if (!normalized) return { isAdmin: false, isSuperAdmin: false };
  const found = participantRoles[normalized];
  if (!found) return { isAdmin: false, isSuperAdmin: false };
  return {
    isAdmin: Boolean(found.isAdmin),
    isSuperAdmin: Boolean(found.isSuperAdmin),
  };
}

function fallbackParticipantLabel(jid) {
  if (!jid || typeof jid !== 'string') return 'unknown';
  const local = jid.split('@')[0] || jid;
  if (!local) return 'unknown';
  const digits = local.replace(/\D/g, '');
  if (digits.length >= 5) return digits;
  return local;
}

function normalizeKickTargets(rawTargets) {
  if (!Array.isArray(rawTargets)) return [];
  const normalized = [];
  for (const target of rawTargets) {
    const senderRef = typeof target?.senderRef === 'string'
      ? target.senderRef.trim().toLowerCase()
      : '';
    const anchorContextMsgId = normalizeContextMsgId(target?.anchorContextMsgId);
    normalized.push({
      senderRef,
      anchorContextMsgId,
    });
  }
  return normalized;
}

function isOwnerJid(senderId) {
  if (!senderId) return false;
  const candidates = new Set();
  const raw = String(senderId).trim().toLowerCase();
  const normalized = (normalizeJid(senderId) || senderId).toLowerCase();
  if (raw) candidates.add(raw);
  if (normalized) candidates.add(normalized);

  for (const candidate of Array.from(candidates)) {
    if (!candidate) continue;
    if (candidate.includes('@')) {
      const [local, domain] = candidate.split('@');
      if (local) {
        candidates.add(local);
        if (local.includes(':')) {
          const base = local.split(':')[0];
          if (base) {
            candidates.add(base);
            candidates.add(`${base}@${domain || 's.whatsapp.net'}`);
          }
        }
      }
    }
    const digits = candidate.replace(/\D/g, '');
    if (digits.length >= 5) {
      candidates.add(digits);
      candidates.add(`${digits}@s.whatsapp.net`);
    }
  }

  const match = config.botOwnerJids.some((ownerJid) => {
    if (!ownerJid) return false;
    const ownerLocal = ownerJid.split('@')[0];
    const ownerDigits = ownerJid.replace(/\D/g, '');
    for (const candidate of candidates) {
      if (candidate === ownerJid) return true;
      if (ownerLocal && candidate === ownerLocal) return true;
      const candidateDigits = candidate.replace(/\D/g, '');
      if (ownerDigits && candidateDigits && ownerDigits === candidateDigits) return true;
    }
    return false;
  });

  return match;
}

export {
  toJidCandidate,
  choosePreferredParticipantJid,
  extractParticipantAliases,
  extractParticipantJids,
  compactParticipantJids,
  rememberParticipantName,
  lookupParticipantName,
  groupParticipantKey,
  participantDisplayName,
  hydrateGroupParticipantCaches,
  participantRoleFlags,
  buildParticipantRoleMap,
  roleFlagsForJid,
  fallbackParticipantLabel,
  normalizeKickTargets,
  isOwnerJid,
};
