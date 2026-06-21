import { WAMessageStubType } from 'baileys';
import type { WAMessage, WAMessageKey } from 'baileys';
import logger from '../../logger.js';
import config from '../../config.js';
import {
  GROUP_METADATA_TTL_MS,
  GROUP_METADATA_FAILURE_COOLDOWN_MS,
  GROUP_PARTICIPANT_NAME_MISS_TTL_MS,
  GROUP_JOIN_DEDUP_TTL_MS,
  GROUP_JOIN_CROSS_SOURCE_DEDUP_TTL_MS,
  GROUP_JOIN_STUB_TYPES,
  cacheSetBounded,
} from './caches.js';
import type { GroupContextValue } from './caches.js';
import type { AccountContext } from '../../account/accountContext.js';
import {
  normalizeJid,
} from './identifiers.js';
import {
  compactParticipantJids,
  hydrateGroupParticipantCaches,
  extractParticipantAliases,
  buildParticipantRoleMap,
  roleFlagsForJid,
  groupParticipantKey,
  lookupParticipantName,
} from './participants.js';

/**
 * Normalized group-join / participant-change event parsed from a Baileys
 * messages.upsert stub.
 */
interface GroupJoinStub {
  chatId: string;
  action: string;
  participants: string[];
  actorId: string | null;
  timestampMs: number;
  messageId: string | null;
  messageKey: WAMessageKey | null;
  source: string;
}

function parseGroupDescription(rawDescription: unknown): { description: string | null } {
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

function pickGroupDescription(meta: unknown): string | null {
  const m = meta as { desc?: unknown; description?: unknown; descText?: unknown } | null | undefined;
  const candidates = [
    m?.desc,
    m?.description,
    m?.descText,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function currentBotAliases(ctx: AccountContext): string[] {
  const sock = ctx.sock;
  if (!sock?.user) return [];
  const user = sock.user as { id?: string; jid?: string; lid?: string; phoneNumber?: string };
  const aliases = extractParticipantAliases([
    user.id,
    user.jid,
    user.lid,
    user.phoneNumber,
  ]);
  if (aliases.length > 0) return aliases;
  const normalized = normalizeJid(sock.user.id);
  return normalized ? [normalized] : [];
}

function normalizeGroupMetadata(ctx: AccountContext, meta: unknown, jid: string): GroupContextValue {
  const m = meta as { subject?: string } | null | undefined;
  const name = m?.subject || jid;
  const rawDescription = pickGroupDescription(meta);
  const { description } = parseGroupDescription(rawDescription || '');
  const participantRoles = buildParticipantRoleMap(meta as { participants?: unknown } | null | undefined);
  const participantsList = (meta as { participants?: unknown } | null | undefined)?.participants;
  const participants = compactParticipantJids(Array.isArray(participantsList) ? participantsList : []);
  const botAliases = currentBotAliases(ctx);
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

function defaultGroupContext(jid: string): GroupContextValue {
  return {
    name: jid,
    description: null,
    botIsAdmin: false,
    botIsSuperAdmin: false,
    participantRoles: {},
    participants: [],
  };
}

function getCachedGroupMetadata(ctx: AccountContext, jid: string): GroupContextValue | null {
  const cached = ctx.groupMetadataCache.get(jid);
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > GROUP_METADATA_TTL_MS) {
    ctx.groupMetadataCache.delete(jid);
    return null;
  }
  return cached.value;
}

function rememberGroupMetadata(ctx: AccountContext, jid: string, value: GroupContextValue): void {
  cacheSetBounded(ctx.groupMetadataCache, jid, {
    fetchedAt: Date.now(),
    value,
  }, 2000);
}

function invalidateGroupMetadata(ctx: AccountContext, jid: string | null | undefined): void {
  if (!jid) return;
  ctx.groupMetadataCache.delete(jid);
}

/**
 * Serve the freshest snapshot we have for a group WITHOUT fetching: the
 * TTL-valid cache if present, otherwise any stale entry (better than nothing),
 * otherwise an empty default. Used when a fetch is suppressed by the cooldown
 * or has just failed.
 */
function freshestGroupSnapshot(ctx: AccountContext, jid: string): GroupContextValue {
  const fresh = getCachedGroupMetadata(ctx, jid);
  if (fresh) return fresh;
  const stale = ctx.groupMetadataCache.get(jid);
  return stale ? stale.value : defaultGroupContext(jid);
}

async function getGroupContext(
  ctx: AccountContext,
  jid: string | null | undefined,
  { forceRefresh = false }: { forceRefresh?: boolean } = {},
): Promise<GroupContextValue> {
  if (!jid) return defaultGroupContext(jid as string);
  const sock = ctx.sock;
  if (!sock) return defaultGroupContext(jid);

  if (!forceRefresh) {
    const cached = getCachedGroupMetadata(ctx, jid);
    if (cached) return cached;
  }

  // Negative cache / backoff: a recent fetch failed (e.g. WhatsApp
  // `rate-overlimit`). Re-firing now only deepens the rate limit (and ban
  // risk — group-metadata refetch is ban-risky, see AGENTS.md), so serve the
  // freshest snapshot we have instead. Applies to forceRefresh too: during an
  // active rate limit a forced query would just fail and extend the cooldown.
  const cooldownUntil = ctx.groupMetadataCooldownUntil.get(jid);
  if (cooldownUntil !== undefined) {
    if (Date.now() < cooldownUntil) return freshestGroupSnapshot(ctx, jid);
    ctx.groupMetadataCooldownUntil.delete(jid);
  }

  // In-flight dedup: coalesce concurrent callers for the same group (a burst
  // of messages) into ONE underlying `sock.groupMetadata` call so they don't
  // stampede WhatsApp. Registration below is synchronous — the worker only
  // yields at its first `await` — so no concurrent caller can miss it.
  const inflight = ctx.groupMetadataInflight.get(jid);
  if (inflight) return inflight;

  const fetchPromise = (async (): Promise<GroupContextValue> => {
    try {
      const { withTimeout } = await import('../index.js');
      const meta: any = await withTimeout(
        sock.groupMetadata(jid),
        config.groupMetadataTimeoutMs,
        `groupMetadata(${jid})`
      );
      hydrateGroupParticipantCaches(ctx, jid, meta?.participants);
      const normalized = normalizeGroupMetadata(ctx, meta, jid);
      rememberGroupMetadata(ctx, jid, normalized);
      ctx.groupMetadataCooldownUntil.delete(jid);
      return normalized;
    } catch (err) {
      logger.warn({
        err,
        jid,
        timeoutMs: config.groupMetadataTimeoutMs,
      }, 'failed to fetch group metadata');
      // Back off so the next message for this group doesn't immediately
      // re-fire a doomed query — that is the stampede behind the
      // rate-overlimit storm.
      cacheSetBounded(
        ctx.groupMetadataCooldownUntil,
        jid,
        Date.now() + GROUP_METADATA_FAILURE_COOLDOWN_MS,
        2000,
      );
      return freshestGroupSnapshot(ctx, jid);
    }
  })();

  ctx.groupMetadataInflight.set(jid, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    ctx.groupMetadataInflight.delete(jid);
  }
}

async function getGroupParticipantName(
  ctx: AccountContext,
  chatId: string | null | undefined,
  participantJid: string | null | undefined,
): Promise<string | null> {
  const sock = ctx.sock;
  if (!sock || !chatId || !participantJid) return null;
  const key = groupParticipantKey(chatId, participantJid);
  const cached = ctx.groupParticipantNameCache.get(key);
  if (cached) return cached;

  // Cheap, in-memory roster lookup runs on EVERY call (before the negative
  // cache) so a name learned since the last miss — via an inbound pushName or a
  // join-event hydrate — is reflected immediately.
  const fallback = lookupParticipantName(ctx, participantJid);
  if (fallback) {
    cacheSetBounded(ctx.groupParticipantNameCache, key, fallback);
    ctx.groupParticipantNameMissUntil.delete(key);
    return fallback;
  }

  // Negative cache: we recently fetched fresh metadata and STILL couldn't name
  // this participant. Skip the rate-limit-prone forced refetch — re-firing it
  // on every message for an unnameable `@lid` sender is what trips
  // `rate-overlimit`. (The roster lookup above already covers names learned
  // since, so this only suppresses the doomed WhatsApp fetch.)
  const missUntil = ctx.groupParticipantNameMissUntil.get(key);
  if (missUntil !== undefined) {
    if (Date.now() < missUntil) return null;
    ctx.groupParticipantNameMissUntil.delete(key);
  }

  const hadCachedMetadata = Boolean(getCachedGroupMetadata(ctx, chatId));
  await getGroupContext(ctx, chatId);
  let resolved = lookupParticipantName(ctx, participantJid);

  if (!resolved && hadCachedMetadata) {
    await getGroupContext(ctx, chatId, { forceRefresh: true });
    resolved = lookupParticipantName(ctx, participantJid);
  }

  if (resolved) {
    cacheSetBounded(ctx.groupParticipantNameCache, key, resolved);
    ctx.groupParticipantNameMissUntil.delete(key);
    return resolved;
  }

  // Confirmed unnameable (even a fresh fetch didn't have them) → arm the
  // negative cache so the next message doesn't force another refetch.
  cacheSetBounded(
    ctx.groupParticipantNameMissUntil,
    key,
    Date.now() + GROUP_PARTICIPANT_NAME_MISS_TTL_MS,
    2000,
  );
  return null;
}

function normalizeGroupJoinAction(action: unknown): string {
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

function dedupeGroupJoinEvent(
  ctx: AccountContext,
  chatId: string,
  participants: unknown,
  action: unknown,
  timestampMs: unknown,
): boolean {
  const ts = Number(timestampMs) || Date.now();
  const normalizedAction = normalizeGroupJoinAction(action);
  const normalizedParticipants = compactParticipantJids(participants).sort();

  // A single join is reported by TWO independent WhatsApp sources: the
  // `messages.upsert` system stub and the `group-participants.update` event.
  // They frequently address the joining member with DIFFERENT JID forms (LID
  // `@lid` vs phone `@s.whatsapp.net`), and `normalizeJid` does not reconcile
  // LID<->phone, so an exact-participant key does not match across the two and
  // the bot triggers twice. Two complementary checks:
  //   1. exact key (chatId+action+participants) over the full TTL — collapses
  //      same-source replays (e.g. history sync) however far apart, and exact
  //      cross-source matches when both sources happen to agree on the JID form.
  //   2. coalescing key (chatId+action+participantCount) over a short window —
  //      collapses the cross-source duplicate whose JID form differs. The two
  //      sources arrive ~simultaneously, so the short window catches them while
  //      still letting genuinely distinct joins (>window apart) through.
  const exactKey = `${chatId}::${normalizedAction}::${normalizedParticipants.join(',')}`;
  const coalesceKey = `${chatId}::${normalizedAction}::n${normalizedParticipants.length}`;

  const exactSeen = ctx.groupJoinDedupCache.get(exactKey);
  if (exactSeen && ts - exactSeen < GROUP_JOIN_DEDUP_TTL_MS) {
    return false;
  }
  const coalesceSeen = ctx.groupJoinDedupCache.get(coalesceKey);
  if (coalesceSeen && ts - coalesceSeen < GROUP_JOIN_CROSS_SOURCE_DEDUP_TTL_MS) {
    return false;
  }
  cacheSetBounded(ctx.groupJoinDedupCache, exactKey, ts, 2000);
  cacheSetBounded(ctx.groupJoinDedupCache, coalesceKey, ts, 2000);
  return true;
}

function stubActionName(stubType: number | null | undefined): string {
  if (typeof stubType !== 'number') return 'join';
  const enumName = WAMessageStubType[stubType];
  if (typeof enumName !== 'string' || !enumName) return 'join';
  return enumName.toLowerCase();
}

function parseGroupJoinStub(msg: WAMessage | null | undefined): GroupJoinStub | null {
  const chatId = msg?.key?.remoteJid;
  if (!chatId || !chatId.endsWith('@g.us')) return null;
  const stubType = msg?.messageStubType;
  if (!GROUP_JOIN_STUB_TYPES.has(stubType as number)) return null;

  const rawParams = Array.isArray(msg?.messageStubParameters)
    ? msg.messageStubParameters
    : [];
  const parsedFromParams = compactParticipantJids(rawParams);
  const participants = parsedFromParams.length > 0
    ? parsedFromParams
    : compactParticipantJids([msg?.participant]);

  if (participants.length === 0) return null;

  const m = msg as (WAMessage & { participantPn?: unknown; key?: WAMessageKey & { participantAlt?: unknown } }) | null | undefined;
  const actorId = compactParticipantJids([
    m?.key?.participantAlt,
    m?.participantPn,
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
