// Table creation + migration helpers for the four logical SQLite databases.
//
// Extracted verbatim from the original src/db.ts (Step 03 structural split).
// These are pure functions over a SqliteDb connection — no module-global state,
// no behavior change. The `Database` class (../Database.ts) calls these during
// open()/recovery; the domain accessors in ../db.ts call the query helpers.

import type { SqliteDb } from "../Database.js";

// ---------------------------------------------------------------------------
// Schema-level constants (used by initSettingsTables + domain accessors)
// ---------------------------------------------------------------------------

const DEFAULT_MODE = "prefix";
const DEFAULT_TRIGGERS = "tag,reply,name";
const GLOBAL_CHAT_ID = "__global__";

// ---------------------------------------------------------------------------
// Pure query helpers (migration helpers)
// ---------------------------------------------------------------------------

function queryRows<T = Record<string, unknown>>(
  db: SqliteDb,
  sql: string,
  ...params: unknown[]
): T[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: T[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject() as T);
  stmt.free();
  return rows;
}

function escapeIdentifier(identifier: string): string {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function tableExists(db: SqliteDb, tableName: string): boolean {
  const rows = queryRows(
    db,
    "SELECT 1 AS ok FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1",
    "table",
    tableName,
  );
  return rows.length > 0;
}

function hasRows(db: SqliteDb, tableName: string): boolean {
  if (!tableExists(db, tableName)) return false;
  const rows = queryRows(
    db,
    `SELECT 1 AS ok FROM ${escapeIdentifier(tableName)} LIMIT 1`,
  );
  return rows.length > 0;
}

function getColumns(db: SqliteDb, tableName: string): Set<string> {
  if (!tableExists(db, tableName)) return new Set();
  const rows = queryRows<{ name: unknown }>(
    db,
    `PRAGMA table_info(${escapeIdentifier(tableName)})`,
  );
  return new Set(rows.map((r) => String(r.name)));
}

// ---------------------------------------------------------------------------
// Table creation + per-table migrations
// ---------------------------------------------------------------------------

function initSettingsTables(db: SqliteDb): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS chat_settings (
      chat_id          TEXT PRIMARY KEY,
      prompt           TEXT,
      permission       INTEGER NOT NULL DEFAULT 0,
      mode             TEXT NOT NULL DEFAULT '${DEFAULT_MODE}',
      triggers         TEXT NOT NULL DEFAULT '${DEFAULT_TRIGGERS}',
      llm2_model       TEXT,
      subagent_enabled INTEGER NOT NULL DEFAULT 0,
      idle_trigger_min INTEGER DEFAULT NULL,
      idle_trigger_max INTEGER DEFAULT NULL,
      announcement_enabled INTEGER NOT NULL DEFAULT 1,
      compatibility_mode TEXT NOT NULL DEFAULT 'auto',
      auto_device      TEXT DEFAULT NULL,
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Migration for existing installs whose chat_settings table predates the
  // subagent_enabled column. Without this, set/get below would fail with
  // "no such column" until the file is recreated.
  const chatSettingsCols = getColumns(db, "chat_settings");
  if (!chatSettingsCols.has("subagent_enabled")) {
    db.run(
      "ALTER TABLE chat_settings ADD COLUMN subagent_enabled INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!chatSettingsCols.has("idle_trigger_min")) {
    db.run(
      "ALTER TABLE chat_settings ADD COLUMN idle_trigger_min INTEGER DEFAULT NULL",
    );
  }
  if (!chatSettingsCols.has("idle_trigger_max")) {
    db.run(
      "ALTER TABLE chat_settings ADD COLUMN idle_trigger_max INTEGER DEFAULT NULL",
    );
  }
  if (!chatSettingsCols.has("announcement_enabled")) {
    db.run(
      "ALTER TABLE chat_settings ADD COLUMN announcement_enabled INTEGER NOT NULL DEFAULT 1",
    );
  }
  if (!chatSettingsCols.has("compatibility_mode")) {
    db.run(
      "ALTER TABLE chat_settings ADD COLUMN compatibility_mode TEXT NOT NULL DEFAULT 'auto'",
    );
  }
  if (!chatSettingsCols.has("auto_device")) {
    db.run("ALTER TABLE chat_settings ADD COLUMN auto_device TEXT DEFAULT NULL");
  }

  // Ensure a __global__ defaults row exists so setGlobal* updates it and
  // get* functions can fall back to it for chats without a specific row.
  db.run(
    `INSERT OR IGNORE INTO chat_settings (chat_id) VALUES (?)`,
    [GLOBAL_CHAT_ID],
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS llm_models (
      model_id       TEXT PRIMARY KEY,
      display_name   TEXT NOT NULL,
      description    TEXT,
      is_active      INTEGER NOT NULL DEFAULT 1,
      sort_order     INTEGER NOT NULL DEFAULT 0,
      vision_support INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Migration: add vision_support column if it doesn't exist
  const columns = getColumns(db, "llm_models");
  if (!columns.has("vision_support")) {
    db.run(
      "ALTER TABLE llm_models ADD COLUMN vision_support INTEGER NOT NULL DEFAULT 0",
    );
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS owner_contact (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      phone_number TEXT NOT NULL,
      display_name TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Bot-wide owner-only configuration (key/value). Holds knobs that are not
  // per-chat settings: e.g. `activation_msg` (the "not activated" notice text)
  // and `require_activation` (runtime override of the env default). Configured
  // via the owner-only /bot-conf command.
  db.run(`
    CREATE TABLE IF NOT EXISTS bot_config (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS activation_codes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      code        TEXT UNIQUE NOT NULL,
      type        TEXT NOT NULL,
      days        INTEGER NOT NULL DEFAULT 0,
      used        INTEGER NOT NULL DEFAULT 0,
      used_by     TEXT DEFAULT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      created_by  TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chat_activations (
      chat_id         TEXT PRIMARY KEY,
      code            TEXT NOT NULL,
      activated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at      TEXT DEFAULT NULL,
      expiry_notified INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Long-term memory (the /memory command). One row per saved fact; `scope_key`
  // is the chat JID for per-chat memory or `__global__` for the shared list
  // every chat sees. Written by Node (the /memory handler) and read by both
  // Node (list/delete) and the Python bridge (injected as the per-turn
  // long-term-memory block), so it lives in the shared settings.db (CONTRACT §8).
  db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_key   TEXT NOT NULL,
      text        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories (scope_key, id)`,
  );

  // Mention bindings for memory text. The LID is the stable source of truth for
  // each `@Name (senderRef)` mention used inside a memory; storing it lets the
  // outbound renderer re-register the senderRef->JID mapping deterministically
  // (zero WhatsApp metadata refetch) after a restart or for a participant who
  // hasn't spoken yet. Keyed by (scope_key, sender_ref) and UPSERTed so it does
  // not grow per add.
  db.run(`
    CREATE TABLE IF NOT EXISTS memory_mentions (
      scope_key   TEXT NOT NULL,
      sender_ref  TEXT NOT NULL,
      lid         TEXT NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (scope_key, sender_ref)
    )
  `);

  // Live display-name roster, keyed by (chat_id, sender_ref). The gateway
  // UPSERTs the sender's most recent pushName on every inbound message; the
  // Python bridge reads it to re-render `@Name (senderRef)` mention tokens in
  // stored /memory & /prompt text with the CURRENT name. This is why a name
  // that was unknown when a memory was saved (so the bot baked the bare LID
  // number) resolves once that person speaks, and a display-name change tracks
  // automatically — the senderRef is the stable join key. Lives in the shared
  // settings.db (CONTRACT §8).
  db.run(`
    CREATE TABLE IF NOT EXISTS participant_names (
      chat_id     TEXT NOT NULL,
      sender_ref  TEXT NOT NULL,
      name        TEXT NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (chat_id, sender_ref)
    )
  `);
}

function initStatsTables(db: SqliteDb): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS chat_stats (
      chat_id      TEXT NOT NULL,
      period_type  TEXT NOT NULL,
      period_key   TEXT NOT NULL,
      stat_key     TEXT NOT NULL,
      stat_value   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chat_id, period_type, period_key, stat_key)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chat_user_stats (
      chat_id      TEXT NOT NULL,
      period_type  TEXT NOT NULL,
      period_key   TEXT NOT NULL,
      sender_ref   TEXT NOT NULL,
      sender_name  TEXT NOT NULL DEFAULT '',
      invoke_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chat_id, period_type, period_key, sender_ref)
    )
  `);
}

function initModerationTables(db: SqliteDb): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS chat_mutes (
      chat_id     TEXT NOT NULL,
      sender_ref  TEXT NOT NULL,
      muted_at    TEXT NOT NULL DEFAULT (datetime('now')),
      duration_m  INTEGER NOT NULL,
      PRIMARY KEY (chat_id, sender_ref)
    )
  `);
}

function initSubagentTables(db: SqliteDb): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS subagent_enabled (
      chat_id     TEXT PRIMARY KEY,
      enabled     INTEGER NOT NULL DEFAULT 0,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

export {
  DEFAULT_MODE,
  DEFAULT_TRIGGERS,
  GLOBAL_CHAT_ID,
  queryRows,
  escapeIdentifier,
  tableExists,
  hasRows,
  getColumns,
  initSettingsTables,
  initStatsTables,
  initModerationTables,
  initSubagentTables,
};
