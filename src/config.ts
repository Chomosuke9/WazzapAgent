import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';

const ENV_PATH = path.resolve(process.cwd(), '.env');
dotenvConfig({ path: ENV_PATH });

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
  // Keep explicit JIDs as-is (e.g. a `…@lid` an operator pasted manually).
  if (trimmed.includes('@')) return [trimmed];
  // A bare number maps to its phone JID. The matching LID is opaque (NOT the
  // phone number), so it's resolved + registered at connect time by
  // resolveLidForPhone/registerOwnerLid — see src/wa/domain/participants.ts.
  return [`${trimmed}@s.whatsapp.net`];
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
  pairingNumber: string | null;
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
  logColor: string;
  baileysLogLevel: string;
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
  activationNoticeEnabled: boolean;
  subagentEnabledDefault: boolean;
  // Feature-availability flags derived from the shared .env so Node can return
  // a clear "not configured yet" error from the settings UI / commands instead
  // of silently accepting a setting that can never take effect. The underlying
  // features run on the Python bridge; on a single-host deploy both processes
  // load the same .env (see featureAvailability.ts).
  llm1Configured: boolean;
  subagentConfigured: boolean;
}

function buildConfig(): Config {
  return {
  instanceId: process.env.INSTANCE_ID || 'default',
  // Optional WhatsApp pairing-code flow (no QR). When set, the gateway requests
  // an 8-char pairing code for this number instead of printing a QR. Must be
  // digits only with country code (e.g. 6281234567890); we strip everything
  // else so values like "+62 812-3456-7890" still work.
  pairingNumber: (process.env.WA_PAIRING_NUMBER || '').replace(/\D/g, '') || null,
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
  // Color output: 'auto' (default, color only on a TTY) | 'always' | 'never'.
  // Shared with the Python bridge (both read LOG_COLOR) and honours NO_COLOR.
  logColor: process.env.LOG_COLOR || 'auto',
  // Level for Baileys' own (very chatty) internal logger. Defaults to 'warn'
  // so its info-level connection/keys chatter is suppressed; raise to 'debug'
  // /'trace' to diagnose the WhatsApp socket, or 'silent' to mute it entirely.
  baileysLogLevel: process.env.BAILEYS_LOG_LEVEL || 'warn',
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
  // Whether to send the "not activated" notice to unactivated chats.
  activationNoticeEnabled: process.env.ACTIVATION_NOTICE_ENABLED !== 'false',
  // Default sub-agent enablement for chats that haven't set their own value.
  // Seeded into the per-tenant __global__ settings row on first boot (see
  // openAccountPersistence); runtime /subagent default on|off overrides it.
  subagentEnabledDefault: process.env.SUBAGENT_ENABLED_DEFAULT === 'true',
  // LLM1 router is "configured" iff a primary or fallback endpoint is set —
  // mirrors the bridge's call_llm1 gate (ADR-2: empty LLM1_ENDPOINT disables
  // LLM1). Used to reject auto/hybrid mode selection with a helpful error when
  // the router isn't set up.
  llm1Configured: Boolean(
    (process.env.LLM1_ENDPOINT || '').trim() ||
    (process.env.LLM1_FALLBACK_ENDPOINT || '').trim(),
  ),
  // The Python sub-agent client defaults SUBAGENT_URL to http://localhost:5000,
  // so the presence of an explicit env value is the signal that the owner
  // actually set the service up. Used to reject /subagent on when unset.
  subagentConfigured: Boolean((process.env.SUBAGENT_URL || '').trim()),
  };
}

const config: Config = buildConfig();

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

// Hot reload: re-read .env on change and mutate the shared config object in
// place so existing importers see updates. Only fields read fresh per-use
// (footer, thresholds, flags, sticker params, etc.) actually take effect;
// boot-consumed fields (ports, host, dirs, DB paths) are already bound, so
// changing them here does nothing until restart.
// ponytail: best-effort, last-writer-wins; no debounce. Add debounce if your
// editor fires multiple write events and the reparse cost ever shows up.
try {
  fs.watch(ENV_PATH, () => {
    try {
      dotenvConfig({ path: ENV_PATH, override: true });
      Object.assign(config, buildConfig());
    } catch {
      // keep last-good config on a malformed save mid-write
    }
  });
} catch {
  // .env absent (env vars set another way) — nothing to watch
}

export default config;
