import config from '../../config.js';
import { cacheSetBounded } from './caches.js';
import type { ParticipantRoleFlags } from './caches.js';
import type { AccountContext } from '../../account/accountContext.js';
import type { WaSocketLike } from '../../protocol/ports.js';
import {
  normalizeJid,
  rememberSenderRef,
} from './identifiers.js';

/**
 * A normalized kick target produced from a raw LLM/tool payload.
 */
interface NormalizedKickTarget {
  senderRef: string;
}

function toJidCandidate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.includes('@')) return trimmed;

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length >= 5) return `${digits}@s.whatsapp.net`;
  return null;
}

function choosePreferredParticipantJid(jids: unknown): string | null {
  if (!Array.isArray(jids) || jids.length === 0) return null;
  const unique = Array.from(new Set(jids.filter((jid) => typeof jid === 'string' && jid.trim()))) as string[];
  if (unique.length === 0) return null;
  const pn = unique.find((jid) => jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us') || jid.endsWith('@lid'));
  return pn || unique[0];
}

function extractParticipantAliases(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    const normalized: string[] = [];
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
  const obj = value as Record<string, unknown>;
  const candidates = [
    obj.phoneNumber,
    obj.pn,
    obj.id,
    obj.jid,
    obj.lid,
    obj.participant,
  ];

  const normalized: string[] = [];
  for (const candidate of candidates) {
    const parsed = toJidCandidate(candidate);
    if (!parsed) continue;
    normalized.push(normalizeJid(parsed) || parsed);
  }
  return Array.from(new Set(normalized));
}

function extractParticipantJids(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    const normalized: string[] = [];
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

function compactParticipantJids(participants: unknown): string[] {
  if (!Array.isArray(participants)) return [];
  const normalized: string[] = [];
  for (const participant of participants) {
    const candidates = extractParticipantJids(participant);
    for (const jid of candidates) {
      const cleaned = normalizeJid(jid) || jid;
      normalized.push(cleaned);
    }
  }
  return Array.from(new Set(normalized));
}

function rememberParticipantName(ctx: AccountContext, jid: unknown, name: unknown): void {
  if (!jid || typeof jid !== 'string') return;
  if (!name || typeof name !== 'string') return;
  const cleaned = name.trim();
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return;
  if (!cleaned) return;

  cacheSetBounded(ctx.participantNameCache, jid, cleaned);
  const normalized = normalizeJid(jid);
  if (normalized) cacheSetBounded(ctx.participantNameCache, normalized, cleaned);
}

function lookupParticipantName(ctx: AccountContext, jid: unknown): string | null {
  if (!jid || typeof jid !== 'string') return null;
  const direct = ctx.participantNameCache.get(jid);
  if (direct) return direct;
  const normalized = normalizeJid(jid);
  if (!normalized) return null;
  return ctx.participantNameCache.get(normalized) || null;
}

function groupParticipantKey(chatId: string, participantJid: string): string {
  const normalized = normalizeJid(participantJid) || participantJid;
  return `${chatId}::${normalized}`;
}

function participantDisplayName(participant: unknown): string | null {
  if (!participant || typeof participant !== 'object') return null;
  const obj = participant as Record<string, unknown>;
  const candidates = [
    obj.name,
    obj.notify,
    obj.pushName,
    obj.verifiedName,
    obj.vname,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const cleaned = candidate.trim();
    if (!/[\p{L}\p{N}]/u.test(cleaned)) continue;
    if (cleaned) return cleaned;
  }
  return null;
}

function hydrateGroupParticipantCaches(ctx: AccountContext, chatId: string | null | undefined, participants: unknown): void {
  if (!chatId || !Array.isArray(participants)) return;
  for (const participant of participants) {
    const aliases = extractParticipantAliases(participant);
    const preferred = choosePreferredParticipantJid(aliases);
    const name = participantDisplayName(participant);
    if (name) {
      for (const alias of aliases) {
        rememberParticipantName(ctx, alias, name);
        cacheSetBounded(ctx.groupParticipantNameCache, groupParticipantKey(chatId, alias), name);
      }
    }
    for (const alias of aliases) {
      rememberSenderRef(ctx, chatId, alias, preferred || alias);
    }
  }
}

function participantRoleFlags(participant: unknown): ParticipantRoleFlags {
  const adminRole = typeof (participant as { admin?: unknown } | null | undefined)?.admin === 'string'
    ? ((participant as { admin: string }).admin).toLowerCase()
    : '';
  const isSuperAdmin = adminRole === 'superadmin';
  const isAdmin = isSuperAdmin || adminRole === 'admin';
  return { isAdmin, isSuperAdmin };
}

function buildParticipantRoleMap(meta: { participants?: unknown } | null | undefined): Record<string, ParticipantRoleFlags> {
  const roleMap: Record<string, ParticipantRoleFlags> = {};
  const rawParticipants = meta?.participants;
  const participants = Array.isArray(rawParticipants) ? rawParticipants : [];
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

function roleFlagsForJid(
  participantRoles: Record<string, ParticipantRoleFlags> | null | undefined,
  jid: unknown,
): ParticipantRoleFlags {
  if (!participantRoles || typeof participantRoles !== 'object') {
    return { isAdmin: false, isSuperAdmin: false };
  }
  const normalized = normalizeJid(jid) || (typeof jid === 'string' ? jid : null);
  if (!normalized) return { isAdmin: false, isSuperAdmin: false };
  const found = participantRoles[normalized];
  if (!found) return { isAdmin: false, isSuperAdmin: false };
  return {
    isAdmin: Boolean(found.isAdmin),
    isSuperAdmin: Boolean(found.isSuperAdmin),
  };
}

function fallbackParticipantLabel(jid: unknown): string {
  if (!jid || typeof jid !== 'string') return 'unknown';
  const local = jid.split('@')[0] || jid;
  if (!local) return 'unknown';
  const digits = local.replace(/\D/g, '');
  if (digits.length >= 5) return digits;
  return local;
}

function normalizeKickTargets(rawTargets: unknown): NormalizedKickTarget[] {
  if (!Array.isArray(rawTargets)) return [];
  const normalized: NormalizedKickTarget[] = [];
  for (const target of rawTargets) {
    const senderRef = typeof target?.senderRef === 'string'
      ? target.senderRef.trim().toLowerCase()
      : '';
    normalized.push({
      senderRef,
    });
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Owner LID resolution
// ---------------------------------------------------------------------------
// WhatsApp now addresses group senders by an opaque LID (e.g.
// `123456789012345@lid`) instead of their phone number. A phone-number-only
// BOT_OWNER_JIDS therefore can't match a LID sender. We resolve each configured
// owner number to its real LID at connect time and register it here so owner
// detection keeps working when you configure plain phone numbers.
const runtimeOwnerLids = new Set<string>();

/** Register a resolved owner LID so {@link isOwnerJid} matches it. Returns true
 * if it was newly added. Only `@lid` JIDs are accepted. */
function registerOwnerLid(lid: unknown): boolean {
  if (typeof lid !== "string") return false;
  const normalized = (normalizeJid(lid) || lid).trim().toLowerCase();
  if (!normalized || !normalized.includes("@lid")) return false;
  if (runtimeOwnerLids.has(normalized)) return false;
  runtimeOwnerLids.add(normalized);
  return true;
}

/**
 * Resolve a phone number (any format — non-digits are stripped) to its WhatsApp
 * LID using Baileys' PN→LID mapping store, which performs a USync network
 * lookup on a cache miss. Returns the full `<lid>@lid` JID or `null`.
 *
 * `sock` is typed loosely because `signalRepository.lidMapping` is not part of
 * the narrow `WaSocketLike` port; access is fully defensive so an older Baileys
 * (or a not-yet-ready socket) just yields `null`.
 */
interface LidResolutionSocket extends WaSocketLike {
  signalRepository?: {
    lidMapping?: {
      getLIDForPN?: (jid: string) => Promise<string | null>;
    };
  };
}

async function resolveLidForPhone(sock: LidResolutionSocket | null, phone: unknown): Promise<string | null> {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length < 5) return null;
  try {
    const mapping = sock?.signalRepository?.lidMapping;
    const fn = mapping?.getLIDForPN;
    if (typeof fn !== "function") return null;
    const lid = await fn.call(mapping, `${digits}@s.whatsapp.net`);
    return typeof lid === "string" && lid.includes("@lid") ? lid.toLowerCase() : null;
  } catch {
    return null;
  }
}

function isOwnerJid(senderId: unknown): boolean {
  if (!senderId) return false;
  const raw = String(senderId).trim().toLowerCase();
  const normalized = (normalizeJid(senderId) || raw).toLowerCase();
  const candidates = new Set([raw, normalized]);
  for (const s of [raw, normalized]) {
    if (s.includes('@')) {
      const local = s.split('@')[0];
      if (local) {
        candidates.add(local);
        if (local.includes(':')) {
          const base = local.split(':')[0];
          if (base) { candidates.add(base); candidates.add(`${base}@s.whatsapp.net`); }
        }
      }
    }
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 5) { candidates.add(digits); candidates.add(`${digits}@s.whatsapp.net`); }
  }
  const ownerEntries = config.botOwnerJids.concat(Array.from(runtimeOwnerLids));
  return ownerEntries.some(ownerJid => {
    if (!ownerJid) return false;
    const ownerLocal = ownerJid.split('@')[0];
    const ownerDigits = ownerJid.replace(/\D/g, '');
    for (const candidate of candidates) {
      if (candidate === ownerJid) return true;
      if (ownerLocal && candidate === ownerLocal) return true;
      const cd = candidate.replace(/\D/g, '');
      if (ownerDigits && cd && ownerDigits === cd) return true;
    }
    return false;
  });
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
  registerOwnerLid,
  resolveLidForPhone,
};
