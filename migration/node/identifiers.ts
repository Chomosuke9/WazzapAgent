/**
 * identifiers.ts — Canonical message and sender reference system.
 *
 * This module manages two core abstractions that the rest of the codebase depends on:
 *
 * 1. **contextMsgId**: A 6-digit per-chat monotonically increasing sequence number
 *    (000000–999999, wraps after 999999). Replaces WhatsApp's opaque `wamid-*` IDs
 *    so LLMs can reliably reference messages in tool calls (e.g., reply_message("000125")).
 *    Only unique within a single chat.
 *
 * 2. **senderRef**: A short deterministic reference per sender per chat (e.g., "u8k2d1").
 *    Derived from SHA1(chatId|senderId) → base-36 → first 6 chars. LLM moderation uses
 *    these instead of raw JIDs because JIDs leak phone numbers and are hard to parse.
 *
 * As of Step 16, both registries live on an {@link AccountContext} (passed as the
 * FIRST argument to every stateful function below) instead of module-global
 * singletons, so each account keeps independent counters/registries even for the
 * same `chatId`. Pure helpers (`normalizeJid`, `normalizeContextMsgId`,
 * `makeSenderRef`, key builders) remain static and take no context.
 */
import { createHash } from 'crypto';
import { jidNormalizedUser } from 'baileys';
import type { WAMessage, WAMessageKey } from 'baileys';
import {
  MAX_CACHE,
  MAX_KEY_INDEX,
  cacheSetBounded,
} from './caches.js';
import type {
  MessageIndexEntry,
  MessageIndexKey,
  SenderRefRegistry,
} from './caches.js';
import type { AccountContext } from './account/accountContext.js';

/**
 * Normalized message key built from a raw Baileys key prior to indexing.
 */
interface NormalizedMessageKey {
  id: string;
  remoteJid: string;
  participant?: string;
  fromMe: boolean;
}

/**
 * Arguments for {@link rememberMessageKeyIndex}.
 */
interface RememberMessageKeyIndexArgs {
  chatId?: string | null;
  contextMsgId?: string | number | null;
  rawKey?: WAMessageKey | null;
  senderId?: string | null;
  senderRef?: string | null;
  senderIsAdmin?: boolean;
  fromMe?: boolean;
  timestampMs?: number;
}

/**
 * Options for {@link rememberMessage}.
 */
interface RememberMessageOptions {
  chatId?: string | null;
  contextMsgId?: string | number | null;
  senderId?: string | null;
  senderRef?: string | null;
  senderIsAdmin?: boolean;
  fromMe?: boolean;
  timestampMs?: number;
}

/**
 * Normalize a WhatsApp JID to its canonical form (device+agent stripped).
 * Returns null if the input is falsy or not a string.
 */
function normalizeJid(jid: unknown): string | null {
  if (!jid || typeof jid !== 'string') return null;
  try {
    return jidNormalizedUser(jid);
  } catch {
    return jid;
  }
}

/**
 * Parse a contextMsgId from a raw value. Accepts "000125" or "<000125>"
 * (LLMs sometimes wrap IDs in angle brackets). Returns null if invalid.
 */
function normalizeContextMsgId(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value).trim();
  const match = raw.match(/^<?\s*(\d{6})\s*>?$/);
  if (!match) return null;
  return match[1];
}

function contextIndexKey(chatId: string, contextMsgId: string): string {
  return `${chatId}::${contextMsgId}`;
}

function messageIdIndexKey(chatId: string, messageId: string): string {
  return `${chatId}::${messageId}`;
}

/**
 * Allocate the next contextMsgId for a chat. Counter wraps at 1,000,000.
 * This is the only function that creates new contextMsgIds — all other functions
 * either look up existing ones or normalize/parse them.
 */
function nextContextMsgId(ctx: AccountContext, chatId: string): string {
  const current = ctx.contextCounterByChat.get(chatId) || 0;
  const bounded = current % 1_000_000;
  ctx.contextCounterByChat.set(chatId, (bounded + 1) % 1_000_000);
  return String(bounded).padStart(6, '0');
}

function ensureSenderRefRegistry(ctx: AccountContext, chatId: string): SenderRefRegistry {
  let registry = ctx.senderRefRegistryByChat.get(chatId);
  if (!registry) {
    registry = {
      senderToRef: new Map<string, string>(),
      refToSender: new Map<string, string>(),
      senderToParticipant: new Map<string, string>(),
    };
    ctx.senderRefRegistryByChat.set(chatId, registry);
  }
  return registry;
}

function makeSenderRef(chatId: string, senderId: string, attempt = 0): string {
  const digest = createHash('sha1').update(`${chatId}|${senderId}|${attempt}`).digest('hex');
  const numeric = Number.parseInt(digest.slice(0, 12), 16);
  return numeric.toString(36).padStart(6, '0').slice(0, 6);
}

function isContactJid(jid: unknown): boolean {
  return typeof jid === 'string'
    && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us') || jid.endsWith('@lid'));
}

/**
 * Register or look up a senderRef for a given sender in a chat.
 *
 * senderRefs are derived from SHA1(chatId|senderId|attempt) → base-36 prefix.
 * If a collision occurs (different sender, same ref), it increments the attempt.
 *
 * Also tracks the mapping from senderId → participantJid (for mention resolution).
 * WhatsApp contact JIDs (@s.whatsapp.net, @c.us, @lid) are preferred over other JIDs.
 *
 * @param ctx      - Per-account state holder
 * @param chatId   - Group or DM JID
 * @param senderId - Normalized sender JID
 * @param participantJid - Group participant JID (may differ from sender on mobile)
 * @returns The 6-char senderRef, or null if inputs are invalid
 */
function rememberSenderRef(
  ctx: AccountContext,
  chatId: string | null | undefined,
  senderId: string | null | undefined,
  participantJid: string | null = null,
): string | null {
  if (!chatId || !senderId) return null;
  const canonicalSenderId = normalizeJid(senderId) || senderId;
  const canonicalParticipant = normalizeJid(participantJid) || participantJid || canonicalSenderId;
  const registry = ensureSenderRefRegistry(ctx, chatId);

  const existingRef = registry.senderToRef.get(canonicalSenderId);
  if (existingRef) {
    const existingParticipant = registry.senderToParticipant.get(canonicalSenderId);
    if (!isContactJid(existingParticipant) || isContactJid(canonicalParticipant)) {
      registry.senderToParticipant.set(canonicalSenderId, canonicalParticipant);
    }
    return existingRef;
  }

  for (let attempt = 0; attempt < 128; attempt += 1) {
    const candidate = makeSenderRef(chatId, canonicalSenderId, attempt);
    const owner = registry.refToSender.get(candidate);
    if (owner && owner !== canonicalSenderId) continue;
    registry.senderToRef.set(canonicalSenderId, candidate);
    registry.refToSender.set(candidate, canonicalSenderId);
    registry.senderToParticipant.set(canonicalSenderId, canonicalParticipant);
    return candidate;
  }

  const fallback = `${Date.now() % 1_000_000}`.padStart(6, '0');
  registry.senderToRef.set(canonicalSenderId, fallback);
  registry.refToSender.set(fallback, canonicalSenderId);
  registry.senderToParticipant.set(canonicalSenderId, canonicalParticipant);
  return fallback;
}

function resolveSenderByRef(
  ctx: AccountContext,
  chatId: string | null | undefined,
  senderRef: unknown,
): string | null {
  if (!chatId || typeof senderRef !== 'string') return null;
  const registry = ctx.senderRefRegistryByChat.get(chatId);
  if (!registry) return null;
  return registry.refToSender.get(senderRef.trim().toLowerCase()) || null;
}

function resolveParticipantBySenderId(
  ctx: AccountContext,
  chatId: string | null | undefined,
  senderId: string | null | undefined,
): string | null {
  if (!chatId || !senderId) return null;
  const registry = ctx.senderRefRegistryByChat.get(chatId);
  if (!registry) return null;
  return registry.senderToParticipant.get(senderId) || null;
}

function buildNormalizedMessageKey(
  rawKey: WAMessageKey | null | undefined,
  chatId: string,
  senderId: string | null = null,
  fromMe = false,
): NormalizedMessageKey | null {
  const keyId = rawKey?.id;
  const remoteJid = rawKey?.remoteJid || chatId;
  if (!keyId || !remoteJid) return null;
  const normalizedSenderId = normalizeJid(senderId) || senderId || null;
  const normalized: NormalizedMessageKey = {
    id: keyId,
    remoteJid,
    participant: rawKey?.participant || normalizedSenderId || undefined,
    fromMe: Boolean(rawKey?.fromMe ?? fromMe),
  };
  return normalized;
}

function rememberMessageKeyIndex(ctx: AccountContext, {
  chatId,
  contextMsgId,
  rawKey,
  senderId = null,
  senderRef = null,
  senderIsAdmin = false,
  fromMe = false,
  timestampMs = Date.now(),
}: RememberMessageKeyIndexArgs): MessageIndexEntry | null {
  const normalizedContextMsgId = normalizeContextMsgId(contextMsgId);
  if (!chatId || !normalizedContextMsgId) return null;
  const key = buildNormalizedMessageKey(rawKey, chatId, senderId, fromMe);
  if (!key) return null;
  const normalizedSenderId = normalizeJid(senderId) || senderId || null;
  const entry: MessageIndexEntry = {
    contextMsgId: normalizedContextMsgId,
    id: key.id,
    chatId,
    remoteJid: key.remoteJid,
    participant: key.participant || null,
    fromMe: Boolean(key.fromMe),
    timestampMs: Number(timestampMs) || Date.now(),
    senderId: normalizedSenderId,
    senderRef: senderRef || null,
    senderIsAdmin: Boolean(senderIsAdmin),
    key: {
      id: key.id,
      remoteJid: key.remoteJid,
      participant: key.participant || undefined,
      fromMe: Boolean(key.fromMe),
    },
  };
  cacheSetBounded(
    ctx.messageKeyIndex,
    contextIndexKey(chatId, normalizedContextMsgId),
    entry,
    MAX_KEY_INDEX
  );
  cacheSetBounded(
    ctx.messageIdToContextId,
    messageIdIndexKey(chatId, key.id),
    normalizedContextMsgId,
    MAX_KEY_INDEX * 2
  );
  return entry;
}

function getIndexedMessageByContextId(
  ctx: AccountContext,
  chatId: string | null | undefined,
  contextMsgId: unknown,
): MessageIndexEntry | null {
  const normalizedContextMsgId = normalizeContextMsgId(contextMsgId);
  if (!chatId || !normalizedContextMsgId) return null;
  return ctx.messageKeyIndex.get(contextIndexKey(chatId, normalizedContextMsgId)) || null;
}

function findContextMsgIdByMessageId(
  ctx: AccountContext,
  chatId: string | null | undefined,
  messageId: string | null | undefined,
): string | null {
  if (!chatId || !messageId) return null;
  const found = ctx.messageIdToContextId.get(messageIdIndexKey(chatId, messageId));
  return normalizeContextMsgId(found);
}

function ensureContextMsgId(ctx: AccountContext, chatId: string, messageId: string): string {
  const known = findContextMsgIdByMessageId(ctx, chatId, messageId);
  if (known) return known;
  return nextContextMsgId(ctx, chatId);
}

/**
 * Store a message in the cache and index it by contextMsgId and messageId.
 *
 * Two indexes are maintained:
 *   - contextIndexKey(chatId, contextMsgId) → message metadata
 *   - messageIdIndexKey(chatId, messageId)   → contextMsgId
 *
 * Used for reply-target resolution (resolveQuotedMessage) and action targeting
 * (react/delete/kick refer to messages by contextMsgId).
 */
function rememberMessage(ctx: AccountContext, msg: WAMessage | null | undefined, {
  chatId = msg?.key?.remoteJid || null,
  contextMsgId = null,
  senderId = null,
  senderRef = null,
  senderIsAdmin = false,
  fromMe = false,
  timestampMs = Date.now(),
}: RememberMessageOptions = {}): string | null {
  if (!msg?.key?.id) return null;
  ctx.messageCache.set(msg.key.id, msg);
  if (ctx.messageCache.size > MAX_CACHE) {
    const firstKey = ctx.messageCache.keys().next().value;
    ctx.messageCache.delete(firstKey as string);
  }
  if (!chatId) return null;
  const resolvedContextMsgId = normalizeContextMsgId(contextMsgId) || ensureContextMsgId(ctx, chatId, msg.key.id);
  rememberMessageKeyIndex(ctx, {
    chatId,
    contextMsgId: resolvedContextMsgId,
    rawKey: msg.key,
    senderId,
    senderRef,
    senderIsAdmin,
    fromMe,
    timestampMs,
  });
  return resolvedContextMsgId;
}

function resolveQuotedMessage(
  ctx: AccountContext,
  chatId: string | null | undefined,
  target: unknown,
): WAMessage | { key: MessageIndexKey; message: { conversation: string } } | null {
  if (!target) return null;
  const maybeContext = normalizeContextMsgId(target);
  if (!maybeContext) {
    return ctx.messageCache.get(target as string) || null;
  }
  const entry = getIndexedMessageByContextId(ctx, chatId, maybeContext);
  if (!entry) return null;
  const cached = entry.id ? ctx.messageCache.get(entry.id) : null;
  if (cached) return cached;
  return { key: entry.key, message: { conversation: '' } };
}

function mentionHandleForJid(jid: unknown): string | null {
  if (!jid || typeof jid !== 'string') return null;
  const normalized = normalizeJid(jid) || jid;
  const local = String(normalized).split('@')[0] || '';
  const cleaned = local.replace(/[^0-9A-Za-z._-]/g, '');
  if (!cleaned) return null;
  return `@${cleaned}`;
}

function resolveMentionTargetBySenderRef(
  ctx: AccountContext,
  chatId: string | null | undefined,
  senderRef: string | null | undefined,
): string | null {
  if (!chatId || !senderRef) return null;
  const senderId = resolveSenderByRef(ctx, chatId, senderRef);
  if (!senderId) return null;
  const participantFromRegistry = resolveParticipantBySenderId(ctx, chatId, senderId);
  return normalizeJid(participantFromRegistry) || normalizeJid(senderId) || senderId || null;
}

export {
  normalizeJid,
  normalizeContextMsgId,
  contextIndexKey,
  messageIdIndexKey,
  nextContextMsgId,
  ensureSenderRefRegistry,
  makeSenderRef,
  isContactJid,
  rememberSenderRef,
  resolveSenderByRef,
  resolveParticipantBySenderId,
  buildNormalizedMessageKey,
  rememberMessageKeyIndex,
  getIndexedMessageByContextId,
  findContextMsgIdByMessageId,
  ensureContextMsgId,
  rememberMessage,
  resolveQuotedMessage,
  mentionHandleForJid,
  resolveMentionTargetBySenderRef,
};
