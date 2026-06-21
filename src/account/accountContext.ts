/**
 * accountContext.ts — Per-account state holder + factory (Step 16, CONTRACT.md §5).
 *
 * Before this step, all per-account state (the message cache, the contextMsgId
 * counter, the senderRef registry, group-metadata caches, the quiz-id set, and
 * the per-JID send queue) lived as module-global `Map`/`Set` singletons in
 * `caches.ts` and `wa/sendQueue.ts`. With multiple accounts those singletons
 * collide: the same `chatId` in two accounts would share one contextMsgId
 * counter and one senderRef registry.
 *
 * `AccountContext` owns ALL of that state. Each {@link createAccountContext}
 * call returns a fresh, fully independent set of maps/sets so two accounts can
 * key the same `chatId` without leaking into each other. `identifiers.ts`,
 * `wa/sendQueue.ts`, the cache helpers, and the `wa/*` modules now receive an
 * `AccountContext` instead of importing the (now-removed) module singletons.
 *
 * This is a LEAF module: it holds nothing but plain in-memory collections plus
 * the `folderPath` key. It MUST NOT create the Baileys socket (Step 17), open a
 * DB, or do any WS logic — those live elsewhere.
 */
import type { WAMessage } from 'baileys';
import type {
  MessageIndexEntry,
  SenderRefRegistry,
  GroupMetadataCacheEntry,
  GroupContextValue,
} from '../wa/domain/caches.js';
import type { AccountRepositories } from '../db/repositories/index.js';
import type { AccountForwarder, WaSocketLike } from '../protocol/ports.js';

/**
 * In-flight `/modelcfg` interactive form for a single chat. `edit_model`
 * carries the model being edited; both variants record the sender allowed to
 * complete the form. Account-scoped (lives on {@link AccountContext}) so two
 * accounts never share `/modelcfg` form state for the same `chatId`.
 */
export type PendingForm =
  | { type: "edit_model"; modelId: string; senderId: string }
  | { type: "add_model"; senderId: string };

/**
 * The concrete per-account state holder. Finalizes the placeholder declared in
 * `protocol/types.ts` (CONTRACT.md §5). Its fields are an internal Node detail
 * and intentionally NOT part of the wire contract.
 */
export interface AccountContext {
  /** Tenant folder this context serves (the account key). */
  folderPath: string;

  /**
   * This tenant's media / sticker directories (CONTRACT.md §8). Set by the
   * factory ({@link import('./baileysFactory.js').createOrResumeAccount}) so
   * every inbound media download, attachment allowlist check, and sticker temp
   * write lands under THIS tenant's folder instead of a process-global dir
   * shared across accounts. For the default single-account tenant these resolve
   * to `config.mediaDir`/`config.stickersDir`/`config.stickerUploadDir` (so the
   * env overrides and single-account layout are unchanged); for additional
   * tenants they are `<folderPath>/{media,stickers,stickers_user}`. `undefined`
   * only when a context is constructed outside the factory (tests), in which
   * case consumers fall back to the `config.*` globals.
   */
  mediaDir?: string;
  stickersDir?: string;
  stickerUploadDir?: string;

  /**
   * Live Baileys socket for this account. Set by the factory once the socket
   * is created (Step 33 — replaces the removed global socket accessor) and
   * refreshed on reconnect. `undefined` until the socket exists. Threaded so
   * every `wa/*` helper and command handler talks to THIS account's socket via
   * `ctx.sock` instead of a process-global single socket. Typed to the
   * {@link WaSocketLike} surface (Step 07 — replaces the former `any`): only
   * the Baileys members the gateway actually calls, so every `sock` boundary is
   * typed without re-stating the whole Baileys socket.
   */
  sock?: WaSocketLike;

  /**
   * This account's event forwarder (Step 07). Set by the factory alongside
   * {@link sock}; lets `wa/events.ts` / `wa/inbound.ts` push Baileys events to
   * the bound Python client via the {@link AccountForwarder} port WITHOUT
   * importing `account/eventForwarder.ts` (breaks the `account/ ↔ wa/` cycle).
   * `undefined` until the factory wires it.
   */
  forwarder?: AccountForwarder;

  /**
   * This account's repository bundle (Step 05). Like {@link sock}, it is a
   * holder set by the factory AFTER the tenant's {@link
   * import('../db/Database.js').Database} is opened — `AccountContext` itself
   * NEVER opens a DB. Threaded so every `wa/*` helper reads/writes THIS
   * tenant's settings/stats/model/activation DBs via `ctx.repos.<domain>`
   * instead of the removed process-global accessors. `undefined` until the
   * factory wires it.
   */
  repos?: AccountRepositories;

  /** WhatsApp message cache keyed by raw `wamid` (see {@link MessageIndexEntry}). */
  messageCache: Map<string, WAMessage>;
  /** Group-metadata cache keyed by group JID, TTL-wrapped. */
  groupMetadataCache: Map<string, GroupMetadataCacheEntry>;
  /**
   * In-flight `groupMetadata` fetches keyed by group JID. Coalesces concurrent
   * callers (a burst of messages for the same group) into ONE underlying
   * `sock.groupMetadata` call so they don't stampede WhatsApp.
   */
  groupMetadataInflight: Map<string, Promise<GroupContextValue>>;
  /**
   * Per-group backoff: epoch-ms until which `groupMetadata` fetches are
   * suppressed after a failure (e.g. `rate-overlimit`). While set, the freshest
   * cached snapshot (or default) is served instead of re-firing a query.
   */
  groupMetadataCooldownUntil: Map<string, number>;
  /** Participant display-name cache keyed by JID. */
  participantNameCache: Map<string, string>;
  /** Per-group participant display-name cache keyed by `chatId::jid`. */
  groupParticipantNameCache: Map<string, string>;
  /**
   * Negative cache for UNRESOLVABLE participant names, keyed by `chatId::jid` →
   * epoch-ms until which the miss stands. Stops `getGroupParticipantName` from
   * forcing a metadata refetch on every message for a name that can't be
   * resolved (e.g. an `@lid` sender absent from group metadata).
   */
  groupParticipantNameMissUntil: Map<string, number>;
  /** Group-join dedup cache keyed by `chatId::action::participants`. */
  groupJoinDedupCache: Map<string, number>;
  /** Message index keyed by `chatId::contextMsgId`. */
  messageKeyIndex: Map<string, MessageIndexEntry>;
  /** Reverse index: `chatId::messageId` → contextMsgId. */
  messageIdToContextId: Map<string, string>;
  /** Per-chat monotonic contextMsgId counter (0..999999, wraps). */
  contextCounterByChat: Map<string, number>;
  /** Per-chat senderRef registry (sender↔ref↔participant maps). */
  senderRefRegistryByChat: Map<string, SenderRefRegistry>;
  /** WhatsApp message IDs of quiz messages sent by the bot (bounded set). */
  quizMessageIds: Set<string>;
  /** Per-JID send-serialization queue (see {@link import('../wa/sendQueue.js')}). */
  jidQueues: Map<string, Promise<void>>;
  /** In-flight `/modelcfg` interactive form per chat (account-scoped). */
  pendingForms: Map<string, PendingForm>;
}

/**
 * Create a fresh, fully independent {@link AccountContext}. Every call returns
 * brand-new collections so two accounts (even with the same `chatId`) keep
 * independent contextMsgId counters and senderRef registries.
 */
export function createAccountContext(folderPath: string): AccountContext {
  return {
    folderPath,
    mediaDir: undefined,
    stickersDir: undefined,
    stickerUploadDir: undefined,
    sock: undefined,
    forwarder: undefined,
    repos: undefined,
    messageCache: new Map<string, WAMessage>(),
    groupMetadataCache: new Map<string, GroupMetadataCacheEntry>(),
    groupMetadataInflight: new Map<string, Promise<GroupContextValue>>(),
    groupMetadataCooldownUntil: new Map<string, number>(),
    participantNameCache: new Map<string, string>(),
    groupParticipantNameCache: new Map<string, string>(),
    groupParticipantNameMissUntil: new Map<string, number>(),
    groupJoinDedupCache: new Map<string, number>(),
    messageKeyIndex: new Map<string, MessageIndexEntry>(),
    messageIdToContextId: new Map<string, string>(),
    contextCounterByChat: new Map<string, number>(),
    senderRefRegistryByChat: new Map<string, SenderRefRegistry>(),
    quizMessageIds: new Set<string>(),
    jidQueues: new Map<string, Promise<void>>(),
    pendingForms: new Map<string, PendingForm>(),
  };
}
