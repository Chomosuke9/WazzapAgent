import { WAMessageStubType } from 'baileys';

/**
 * caches.ts — Stateless cache helpers, bound/TTL constants, and the cache type
 * definitions shared across the gateway.
 *
 * As of Step 16 this module no longer holds ANY module-global mutable per-chat
 * state. Every former singleton `Map`/`Set` (messageCache, groupMetadataCache,
 * participant name caches, groupJoinDedupCache, messageKeyIndex,
 * messageIdToContextId, contextCounterByChat, senderRefRegistryByChat,
 * quizMessageIds) now lives inside an {@link import('./account/accountContext.js').AccountContext}
 * so each account owns independent state. What remains here is purely stateless:
 * the type definitions, the bound/TTL constants, the {@link cacheSetBounded}
 * helper, and the {@link GROUP_JOIN_STUB_TYPES} set of WhatsApp stub enum values.
 */

/**
 * Normalized WhatsApp message key shape persisted inside a {@link MessageIndexEntry}.
 */
export interface MessageIndexKey {
  id: string;
  remoteJid: string;
  participant?: string;
  fromMe: boolean;
}

/**
 * Indexed metadata for a single message, keyed by `chatId::contextMsgId`.
 */
export interface MessageIndexEntry {
  contextMsgId: string;
  id: string;
  chatId: string;
  remoteJid: string;
  participant: string | null;
  fromMe: boolean;
  timestampMs: number;
  senderId: string | null;
  senderRef: string | null;
  senderIsAdmin: boolean;
  key: MessageIndexKey;
}

/**
 * Per-chat senderRef registry: bidirectional sender↔ref maps plus the
 * sender→participant mapping used for mention resolution.
 */
export interface SenderRefRegistry {
  senderToRef: Map<string, string>;
  refToSender: Map<string, string>;
  senderToParticipant: Map<string, string>;
}

/**
 * Role flags for a single participant within a cached group metadata entry.
 */
export interface ParticipantRoleFlags {
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

/**
 * Normalized group context value cached behind a TTL wrapper.
 */
export interface GroupContextValue {
  name: string;
  description: string | null;
  botIsAdmin: boolean;
  botIsSuperAdmin: boolean;
  participantRoles: Record<string, ParticipantRoleFlags>;
  participants: string[];
}

/**
 * TTL wrapper for a cached {@link GroupContextValue}.
 */
export interface GroupMetadataCacheEntry {
  fetchedAt: number;
  value: GroupContextValue;
}

// Max cached WhatsApp message protos per account (keyed by messageId). This is
// also the re-download source for lazy media (feature 8 download_media), so it
// is kept generous to reduce the chance the proto is evicted before Python
// asks for the media bytes.
const MAX_CACHE = 1000;
const MAX_KEY_INDEX = 12_000;
const GROUP_METADATA_TTL_MS = 60_000;
const GROUP_JOIN_DEDUP_TTL_MS = 15_000;
// Shorter window for cross-source coalescing of the SAME join reported by both
// the `messages.upsert` system stub and the `group-participants.update` event.
// Those two sources can address the joining member with different JID forms
// (LID `@lid` vs phone `@s.whatsapp.net`), so the exact-participant key does not
// match across them. They arrive ~simultaneously, so a short window collapses
// the duplicate while still letting genuinely distinct joins (>5s apart) pass.
const GROUP_JOIN_CROSS_SOURCE_DEDUP_TTL_MS = 5_000;
// Maximum number of quiz message IDs tracked per account before the oldest is
// evicted. The set itself lives on the AccountContext.
const MAX_QUIZ_IDS = 2000;

const GROUP_JOIN_STUB_TYPES = new Set<number>([
  WAMessageStubType.GROUP_PARTICIPANT_ADD,
  WAMessageStubType.GROUP_PARTICIPANT_INVITE,
  WAMessageStubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN,
  WAMessageStubType.GROUP_PARTICIPANT_ACCEPT,
  WAMessageStubType.GROUP_PARTICIPANT_LINKED_GROUP_JOIN,
  WAMessageStubType.GROUP_PARTICIPANT_JOINED_GROUP_AND_PARENT_GROUP,
  WAMessageStubType.CAG_INVITE_AUTO_ADD,
  WAMessageStubType.CAG_INVITE_AUTO_JOINED,
  WAMessageStubType.SUB_GROUP_PARTICIPANT_ADD_RICH,
  WAMessageStubType.COMMUNITY_PARTICIPANT_ADD_RICH,
  WAMessageStubType.SUBGROUP_ADMIN_TRIGGERED_AUTO_ADD_RICH,
].filter((value) => Number.isInteger(value)));

function cacheSetBounded<K, V>(map: Map<K, V>, key: K, value: V, maxSize = 5000): void {
  map.set(key, value);
  if (map.size > maxSize) {
    const firstKey = map.keys().next().value;
    map.delete(firstKey as K);
  }
}

export {
  MAX_CACHE,
  MAX_KEY_INDEX,
  GROUP_METADATA_TTL_MS,
  GROUP_JOIN_DEDUP_TTL_MS,
  GROUP_JOIN_CROSS_SOURCE_DEDUP_TTL_MS,
  MAX_QUIZ_IDS,
  GROUP_JOIN_STUB_TYPES,
  cacheSetBounded,
};
