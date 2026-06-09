import { WAMessageStubType } from 'baileys';

const messageCache = new Map();
const MAX_CACHE = 400;
const MAX_KEY_INDEX = 12_000;
const GROUP_METADATA_TTL_MS = 60_000;
const GROUP_JOIN_DEDUP_TTL_MS = 15_000;
const groupMetadataCache = new Map();
const participantNameCache = new Map();
const groupParticipantNameCache = new Map();
const groupJoinDedupCache = new Map();
const messageKeyIndex = new Map();
const messageIdToContextId = new Map();
const contextCounterByChat = new Map();
const senderRefRegistryByChat = new Map();
// Tracks WhatsApp message IDs of quiz messages sent by the bot.
// Used by inbound.js to decide whether a plain-text reply to an
// interactiveMessage is answering a quiz (→ allow LLM) or interacting
// with a settings menu (→ suppress, already handled by Node).
// Bounded to 2000 entries; oldest entry evicted when full.
const quizMessageIds = new Set();
const MAX_QUIZ_IDS = 2000;
const GROUP_JOIN_STUB_TYPES = new Set([
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

function cacheSetBounded(map, key, value, maxSize = 5000) {
  map.set(key, value);
  if (map.size > maxSize) {
    const firstKey = map.keys().next().value;
    map.delete(firstKey);
  }
}

export {
  messageCache,
  MAX_CACHE,
  MAX_KEY_INDEX,
  GROUP_METADATA_TTL_MS,
  GROUP_JOIN_DEDUP_TTL_MS,
  groupMetadataCache,
  participantNameCache,
  groupParticipantNameCache,
  groupJoinDedupCache,
  messageKeyIndex,
  messageIdToContextId,
  contextCounterByChat,
  senderRefRegistryByChat,
  GROUP_JOIN_STUB_TYPES,
  cacheSetBounded,
  quizMessageIds,
  MAX_QUIZ_IDS,
};
