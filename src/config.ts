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
// User-uploaded stickers live in a separate directory from config.stickersDir
// (which holds admin-managed static stickers).
const STICKER_UPLOAD_DIR = process.env.STICKER_UPLOAD_DIR || path.join(DATA_DIR, 'stickers_user');
// Sticker catalog DB path — mirrors what Python's sticker_db.py resolves to.
const STICKERS_DB_PATH = process.env.BOT_STICKERS_DB_PATH
  || process.env.STICKERS_DB_PATH
  || path.join(DATA_DIR, 'stickers.db');

fs.ensureDirSync(AUTH_DIR);
fs.ensureDirSync(MEDIA_DIR);
fs.ensureDirSync(STICKERS_DIR);

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function nonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function normalizeOwnerJid(raw: string): string[] {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return [];
  if (trimmed.includes('@')) return [trimmed];
  return [`${trimmed}@s.whatsapp.net`, `${trimmed}@lid`];
}

function parseJidList(raw: string | undefined): string[] {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(',')
    .flatMap(normalizeOwnerJid)
    .filter(Boolean);
}

export interface Config {
  instanceId: string;
  wsListenPort: number;
  wsBindHost: string;
  wsMaxPayloadBytes: number;
  wsToken: string | null;
  dataDir: string;
  settingsDbPath: string;
  statsDbPath: string;
  moderationDbPath: string;
  subagentDbPath: string;
  wsHeartbeatIntervalMs: number;
  authDir: string;
  mediaDir: string;
  stickersDir: string;
  stickerUploadDir: string;
  stickersDbPath: string;
  logLevel: string;
  groupMetadataTimeoutMs: number;
  downloadTimeoutMs: number;
  sendTimeoutMs: number;
  upsertConcurrency: number;
  staleMessageMaxAgeMs: number;
  perfLogEnabled: boolean;
  perfLogThresholdMs: number;
  botOwnerJids: string[];
  llmReplyInteractive: boolean;
  llmReplyFooter: string;
  stickerMaxDurationSec: number;
  stickerMaxSizeKb: number;
  stickerFps: number;
  stickerQuality: number;
  stickerPackName: string;
  stickerEmoji: string;
  requireActivation: boolean;
  subagentEnabledDefault: boolean;
}

const config: Config = {
  instanceId: process.env.INSTANCE_ID || 'default',
  wsListenPort: positiveInt(process.env.WS_LISTEN_PORT, 3000),
  // Secure default: bind the gateway WS server to loopback only. Cross-host
  // deployments (Python bridge on a different machine) must explicitly opt in
  // with WS_BIND_HOST=0.0.0.0 AND should set LLM_WS_TOKEN.
  wsBindHost: process.env.WS_BIND_HOST || '127.0.0.1',
  // Cap inbound WS frame size so a single oversized frame can't be buffered
  // and JSON.parse'd into a memory-exhaustion DoS (ws default is 100 MiB).
  wsMaxPayloadBytes: positiveInt(process.env.WS_MAX_PAYLOAD_BYTES, 8 * 1024 * 1024),
  wsToken: process.env.LLM_WS_TOKEN || null,
  dataDir: DATA_DIR,
  settingsDbPath: SETTINGS_DB_PATH,
  statsDbPath: STATS_DB_PATH,
  moderationDbPath: MODERATION_DB_PATH,
  subagentDbPath: SUBAGENT_DB_PATH,
  wsHeartbeatIntervalMs: positiveInt(process.env.WS_HEARTBEAT_INTERVAL_MS, 20000),
  authDir: AUTH_DIR,
  mediaDir: MEDIA_DIR,
  stickersDir: STICKERS_DIR,
  stickerUploadDir: STICKER_UPLOAD_DIR,
  stickersDbPath: STICKERS_DB_PATH,
  logLevel: process.env.LOG_LEVEL || 'info',
  groupMetadataTimeoutMs: positiveInt(process.env.GROUP_METADATA_TIMEOUT_MS, 8000),
  downloadTimeoutMs: positiveInt(process.env.DOWNLOAD_TIMEOUT_MS, 60000),
  sendTimeoutMs: positiveInt(process.env.SEND_TIMEOUT_MS, 60000),
  upsertConcurrency: positiveInt(process.env.UPSERT_CONCURRENCY, 2),
  // Drop inbound WhatsApp messages older than this (ms) so the bot does not
  // process the backlog WhatsApp flushes after the socket reconnects from being
  // offline. Default 5000 (5s). Set STALE_MESSAGE_MAX_AGE_MS=0 to disable.
  staleMessageMaxAgeMs: nonNegativeInt(process.env.STALE_MESSAGE_MAX_AGE_MS, 5000),
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
  // Default sub-agent enablement for chats that haven't set their own value.
  // Seeded into the per-tenant __global__ settings row on first boot (see
  // openAccountPersistence); runtime /subagent default on|off overrides it.
  subagentEnabledDefault: process.env.SUBAGENT_ENABLED_DEFAULT === 'true',
};

// Startup validation for required transport vars. Defaults exist
// (WS_LISTEN_PORT=3000), so a successful boot with defaults is unaffected;
// this only surfaces a clear error for a genuinely invalid configuration.
function validateConfig(c: Config): void {
  if (!Number.isInteger(c.wsListenPort) || c.wsListenPort < 1 || c.wsListenPort > 65535) {
    throw new Error(
      `Invalid WS_LISTEN_PORT (resolved=${c.wsListenPort}): must be an integer between 1 and 65535.`,
    );
  }
}

validateConfig(config);

export default config;
