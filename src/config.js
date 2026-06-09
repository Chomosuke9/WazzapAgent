import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const AUTH_DIR = path.join(DATA_DIR, 'auth');
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(DATA_DIR, 'media');
const STICKERS_DIR = process.env.STICKERS_DIR || path.join(DATA_DIR, 'stickers');
const SETTINGS_DB_PATH = process.env.SETTINGS_DB_PATH || path.join(DATA_DIR, 'settings.db');
const STATS_DB_PATH = process.env.STATS_DB_PATH || path.join(DATA_DIR, 'stats.db');
const MODERATION_DB_PATH = process.env.MODERATION_DB_PATH || path.join(DATA_DIR, 'moderation.db');
const SUBAGENT_DB_PATH = process.env.SUBAGENT_DB_PATH || path.join(DATA_DIR, 'subagent.db');

fs.ensureDirSync(AUTH_DIR);
fs.ensureDirSync(MEDIA_DIR);
fs.ensureDirSync(STICKERS_DIR);

function positiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function nonNegativeInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function parseRatio(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

function normalizeOwnerJid(raw) {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return [];
  if (trimmed.includes('@')) return [trimmed];
  return [`${trimmed}@s.whatsapp.net`, `${trimmed}@lid`];
}

function parseJidList(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(',')
    .flatMap(normalizeOwnerJid)
    .filter(Boolean);
}

const config = {
  instanceId: process.env.INSTANCE_ID || 'default',
  wsEndpoint: process.env.LLM_WS_ENDPOINT,
  wsToken: process.env.LLM_WS_TOKEN || null,
  dataDir: DATA_DIR,
  settingsDbPath: SETTINGS_DB_PATH,
  statsDbPath: STATS_DB_PATH,
  moderationDbPath: MODERATION_DB_PATH,
  subagentDbPath: SUBAGENT_DB_PATH,
  wsReconnectIntervalMs: positiveInt(process.env.WS_RECONNECT_MS, 5000),
  wsReconnectMaxMs: positiveInt(process.env.WS_RECONNECT_MAX_MS, 60000),
  wsReconnectJitterRatio: parseRatio(process.env.WS_RECONNECT_JITTER_RATIO, 0.2),
  wsHeartbeatIntervalMs: positiveInt(process.env.WS_HEARTBEAT_INTERVAL_MS, 20000),
  wsHeartbeatTimeoutMs: positiveInt(process.env.WS_HEARTBEAT_TIMEOUT_MS, 20000),
  authDir: AUTH_DIR,
  mediaDir: MEDIA_DIR,
  stickersDir: STICKERS_DIR,
  logLevel: process.env.LOG_LEVEL || 'info',
  groupMetadataTimeoutMs: positiveInt(process.env.GROUP_METADATA_TIMEOUT_MS, 8000),
  downloadTimeoutMs: positiveInt(process.env.DOWNLOAD_TIMEOUT_MS, 60000),
  sendTimeoutMs: positiveInt(process.env.SEND_TIMEOUT_MS, 60000),
  upsertConcurrency: positiveInt(process.env.UPSERT_CONCURRENCY, 2),
  perfLogEnabled: process.env.PERF_LOG_ENABLED !== '0',
  perfLogThresholdMs: nonNegativeInt(process.env.PERF_LOG_THRESHOLD_MS, 400),
  botOwnerJids: parseJidList(process.env.BOT_OWNER_JIDS),
  llmReplyInteractive: process.env.LLM_REPLY_INTERACTIVE === 'true',
  llmReplyFooter: process.env.LLM_REPLY_FOOTER || '',
  stickerMaxDurationSec: positiveInt(process.env.STICKER_MAX_DURATION_SEC, 6),
  stickerMaxSizeKb: positiveInt(process.env.STICKER_MAX_SIZE_KB, 1024),
  stickerFps: positiveInt(process.env.STICKER_FPS, 15),
  stickerQuality: positiveInt(process.env.STICKER_QUALITY, 75),
  stickerPackName: process.env.STICKER_PACK_NAME || 'WazzapAgents',
  stickerEmoji: process.env.STICKER_EMOJI || '🤖',
  requireActivation: process.env.REQUIRE_ACTIVATION === 'true',
};

export default config;
