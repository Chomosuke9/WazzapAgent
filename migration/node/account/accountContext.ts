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
} from '../caches.js';

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
   * Live Baileys socket for this account. Set by the factory once the socket
   * is created (Step 33 — replaces the removed global socket accessor) and
   * refreshed on reconnect. `undefined` until the socket exists. Threaded so
   * every `wa/*` helper and command handler talks to THIS account's socket via
   * `ctx.sock` instead of a process-global single socket. Typed loosely (`any`)
   * to preserve the behaviour of the original untyped `connection.js` accessor
   * that all these importers were written against.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sock?: any;

  /** WhatsApp message cache keyed by raw `wamid` (see {@link MessageIndexEntry}). */
  messageCache: Map<string, WAMessage>;
  /** Group-metadata cache keyed by group JID, TTL-wrapped. */
  groupMetadataCache: Map<string, GroupMetadataCacheEntry>;
  /** Participant display-name cache keyed by JID. */
  participantNameCache: Map<string, string>;
  /** Per-group participant display-name cache keyed by `chatId::jid`. */
  groupParticipantNameCache: Map<string, string>;
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
    sock: undefined,
    messageCache: new Map<string, WAMessage>(),
    groupMetadataCache: new Map<string, GroupMetadataCacheEntry>(),
    participantNameCache: new Map<string, string>(),
    groupParticipantNameCache: new Map<string, string>(),
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
