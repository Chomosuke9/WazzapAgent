import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import logger from "./logger.js";
import config from "./config.js";

const VALID_MODES = new Set(["auto", "prefix", "hybrid"]);
const DEFAULT_MODE = "prefix";
const VALID_TRIGGERS = new Set(["tag", "reply", "join", "name"]);
const DEFAULT_TRIGGERS = "tag,reply,name";
const GLOBAL_CHAT_ID = "__global__";
const SQLITE_BUSY_TIMEOUT_MS = parsePositiveIntEnv("DB_BUSY_TIMEOUT_MS", 30000);
const SQLITE_OPERATION_RETRY_MAX = parsePositiveIntEnv(
  "DB_OPERATION_RETRY_MAX",
  8,
);
const SQLITE_OPERATION_RETRY_BASE_MS = parsePositiveIntEnv(
  "DB_OPERATION_RETRY_BASE_MS",
  50,
);
const SQLITE_RECOVERY_LOCK_STALE_MS = parsePositiveIntEnv(
  "DB_RECOVERY_LOCK_STALE_MS",
  120000,
);
// Deadline waiting *for* the lock is independent of the staleness window so a
// legitimately slow recovery isn't both still-running and considered stale at
// the same moment.
const SQLITE_RECOVERY_LOCK_WAIT_MS = parsePositiveIntEnv(
  "DB_RECOVERY_LOCK_WAIT_MS",
  SQLITE_RECOVERY_LOCK_STALE_MS * 2,
);

const _settingsState = { db: null, dbPath: null };
const _statsState = { db: null, dbPath: null };
const _moderationState = { db: null, dbPath: null };
const _subagentState = { db: null, dbPath: null };

const DB_CORRUPTION_TOKENS = [
  "malformed",
  "disk image is malformed",
  "not a database",
  "file is not a database",
  "file is encrypted",
  "database corruption",
];

const DB_BUSY_TOKENS = [
  "database is locked",
  "database table is locked",
  "database is busy",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
];

function noop() {}

function parsePositiveIntEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function normalizeParams(params) {
  if (params === undefined || params === null) return [];
  return Array.isArray(params) ? params : [params];
}

class SqliteStatement {
  constructor(stmt, retryFn) {
    this.stmt = stmt;
    this.retryFn = retryFn;
    this.params = [];
    this.rows = null;
    this.index = 0;
  }

  bind(params) {
    this.params = normalizeParams(params);
    this.rows = null;
    this.index = 0;
  }

  step() {
    if (this.rows === null) {
      this.rows = this.retryFn(() => this.stmt.all(...this.params));
    }
    return this.index < this.rows.length;
  }

  getAsObject() {
    if (this.rows === null) {
      this.rows = this.retryFn(() => this.stmt.all(...this.params));
    }
    const row = this.rows[this.index];
    this.index += 1;
    return row;
  }

  free() {
    this.rows = null;
  }
}

class SqliteDb {
  constructor(dbPath, options = {}) {
    this.dbPath = dbPath;
    this.native = new Database(dbPath, {
      timeout: SQLITE_BUSY_TIMEOUT_MS,
      ...options,
    });
  }

  run(sql, params) {
    return retrySqliteOperation(() => {
      const values = normalizeParams(params);
      if (values.length === 0) {
        this.native.exec(sql);
        return;
      }
      this.native.prepare(sql).run(...values);
    });
  }

  prepare(sql) {
    return new SqliteStatement(
      retrySqliteOperation(() => this.native.prepare(sql)),
      retrySqliteOperation,
    );
  }

  pragma(sql) {
    return retrySqliteOperation(() => this.native.pragma(sql));
  }

  close() {
    this.native.close();
  }
}

function closeAllDbs() {
  const states = [_settingsState, _statsState, _moderationState, _subagentState];
  for (const state of states) {
    if (!state.db) continue;
    try {
      state.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch (err) {
      logger.warn({ err, dbPath: state.dbPath }, "DB checkpoint failed");
    }
    closeDb(state.db);
    state.db = null;
  }
  logger.info("All SQLite databases closed");
}

function runTransaction(db, fn) {
  db.run("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.run("COMMIT");
    return result;
  } catch (err) {
    try {
      db.run("ROLLBACK");
    } catch (rollbackErr) {
      noop(rollbackErr);
    }
    throw err;
  }
}

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getSettingsDbPath() {
  if (_settingsState.dbPath) return _settingsState.dbPath;
  _settingsState.dbPath = config.settingsDbPath;
  ensureParentDir(_settingsState.dbPath);
  return _settingsState.dbPath;
}

function getStatsDbPath() {
  if (_statsState.dbPath) return _statsState.dbPath;
  _statsState.dbPath = config.statsDbPath;
  ensureParentDir(_statsState.dbPath);
  return _statsState.dbPath;
}

function getModerationDbPath() {
  if (_moderationState.dbPath) return _moderationState.dbPath;
  _moderationState.dbPath = config.moderationDbPath;
  ensureParentDir(_moderationState.dbPath);
  return _moderationState.dbPath;
}

function getSubagentDbPath() {
  if (_subagentState.dbPath) return _subagentState.dbPath;
  _subagentState.dbPath = config.subagentDbPath;
  ensureParentDir(_subagentState.dbPath);
  return _subagentState.dbPath;
}

function configureDb(db) {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  db.pragma("wal_autocheckpoint = 1000");
  db.pragma("journal_size_limit = 67108864");
  db.pragma("temp_store = MEMORY");
  db.pragma("foreign_keys = ON");
  db.pragma("cache_size = -4000");
}

function closeDb(db) {
  if (!db) return;
  try {
    db.close();
  } catch (err) {
    noop(err);
  }
}

function isDbCorruptionError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return DB_CORRUPTION_TOKENS.some((token) => msg.includes(token));
}

function isDbBusyError(err) {
  const msg = String(err?.message || err?.code || err || "").toLowerCase();
  return DB_BUSY_TOKENS.some((token) => msg.includes(token.toLowerCase()));
}

function retrySqliteOperation(fn) {
  let attempt = 0;
  while (true) {
    try {
      return fn();
    } catch (err) {
      if (!isDbBusyError(err) || attempt >= SQLITE_OPERATION_RETRY_MAX) {
        throw err;
      }
      sleepSync(SQLITE_OPERATION_RETRY_BASE_MS * 2 ** attempt);
      attempt += 1;
    }
  }
}

function backupCorruptFile(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  let backupPath = `${dbPath}.corrupted.bak`;
  if (fs.existsSync(backupPath)) {
    let i = 1;
    while (fs.existsSync(`${dbPath}.corrupted.${i}.bak`)) i += 1;
    backupPath = `${dbPath}.corrupted.${i}.bak`;
  }
  try {
    fs.renameSync(dbPath, backupPath);
    logger.warn({ dbPath, backupPath }, "DB recovery: corrupt DB backed up");
    return backupPath;
  } catch (err) {
    logger.error({ err, dbPath }, "DB recovery: corrupt DB backup failed");
    try {
      fs.unlinkSync(dbPath);
      logger.warn({ dbPath }, "DB recovery: corrupt DB deleted");
    } catch (deleteErr) {
      noop(deleteErr);
    }
    return null;
  }
}

function probeDb(dbPath) {
  if (!fs.existsSync(dbPath)) return true;
  let db = null;
  try {
    db = new SqliteDb(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.pragma("integrity_check");
    return rows.length > 0 && rows.every((row) => row.integrity_check === "ok");
  } catch (err) {
    return false;
  } finally {
    closeDb(db);
  }
}

function withRecoveryLock(dbPath, fn) {
  const lockPath = `${dbPath}.recover.lock`;
  const deadline = Date.now() + SQLITE_RECOVERY_LOCK_WAIT_MS;
  let fd = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
      } catch (writeErr) {
        // Don't leak the fd or the lock file if the write itself fails
        // (e.g. ENOSPC). Close + unlink so peers aren't blocked until the
        // staleness window elapses.
        try {
          fs.closeSync(fd);
        } catch (closeErr) {
          noop(closeErr);
        }
        fd = null;
        try {
          fs.unlinkSync(lockPath);
        } catch (unlinkErr) {
          noop(unlinkErr);
        }
        throw writeErr;
      }
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > SQLITE_RECOVERY_LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (statErr) {
        if (statErr.code === "ENOENT") continue;
        throw statErr;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for DB recovery lock: ${lockPath}`);
      }
      sleepSync(50);
    }
  }

  // Refresh the lock's mtime periodically while we hold it so peers don't
  // mistake an in-progress recovery for a stale lock and steal it.
  const heartbeatMs = Math.max(
    1000,
    Math.floor(SQLITE_RECOVERY_LOCK_STALE_MS / 4),
  );
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(lockPath, now, now);
    } catch (err) {
      noop(err);
    }
  }, heartbeatMs);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  try {
    return fn();
  } finally {
    clearInterval(heartbeat);
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch (err) {
      noop(err);
    }
    try {
      fs.unlinkSync(lockPath);
    } catch (err) {
      noop(err);
    }
  }
}

function recoverCorruptDb(dbPath) {
  return withRecoveryLock(dbPath, () => {
    if (probeDb(dbPath)) return;

    for (const ext of ["-wal", "-shm", "-journal"]) {
      const p = `${dbPath}${ext}`;
      if (fs.existsSync(p)) backupCorruptFile(p);
    }

    if (probeDb(dbPath)) {
      logger.info({ dbPath }, "DB recovery: database usable after sidecar quarantine");
      return;
    }

    backupCorruptFile(dbPath);
  });
}

function openDbWithRecovery(dbPath, initTablesFn) {
  let db = null;
  try {
    db = new SqliteDb(dbPath);
    configureDb(db);
    const rows = db.pragma("quick_check");
    if (!rows.every((row) => row.quick_check === "ok")) {
      throw new Error("database disk image is malformed");
    }
    initTablesFn(db);
    return db;
  } catch (err) {
    closeDb(db);
    if (!isDbCorruptionError(err)) throw err;
    logger.warn({ err, dbPath }, "DB appears corrupt on open; recovering");
    recoverCorruptDb(dbPath);
    db = new SqliteDb(dbPath);
    configureDb(db);
    const rows = db.pragma("quick_check");
    if (!rows.every((row) => row.quick_check === "ok")) {
      throw new Error("database disk image is malformed");
    }
    initTablesFn(db);
    return db;
  }
}

function replaceDb(state, initTablesFn) {
  closeDb(state.db);
  state.db = openDbWithRecovery(state.dbPath, initTablesFn);
}

function recoverStateAfterCorruption(state, initTablesFn, err) {
  closeDb(state.db);
  state.db = null;
  logger.warn(
    { err, dbPath: state.dbPath },
    "DB corruption detected during query; recovering",
  );
  recoverCorruptDb(state.dbPath);
  replaceDb(state, initTablesFn);
}

function withDbRecovery(state, initTablesFn, fn) {
  try {
    return fn();
  } catch (err) {
    if (!isDbCorruptionError(err)) throw err;
    recoverStateAfterCorruption(state, initTablesFn, err);
    return fn();
  }
}

function initSettingsTables(db) {
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
}

function initStatsTables(db) {
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

function initModerationTables(db) {
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

function initSubagentTables(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS subagent_enabled (
      chat_id     TEXT PRIMARY KEY,
      enabled     INTEGER NOT NULL DEFAULT 0,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function queryRows(db, sql, ...params) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function escapeIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function tableExists(db, tableName) {
  const rows = queryRows(
    db,
    "SELECT 1 AS ok FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1",
    "table",
    tableName,
  );
  return rows.length > 0;
}

function hasRows(db, tableName) {
  if (!tableExists(db, tableName)) return false;
  const rows = queryRows(
    db,
    `SELECT 1 AS ok FROM ${escapeIdentifier(tableName)} LIMIT 1`,
  );
  return rows.length > 0;
}

function getColumns(db, tableName) {
  if (!tableExists(db, tableName)) return new Set();
  const rows = queryRows(
    db,
    `PRAGMA table_info(${escapeIdentifier(tableName)})`,
  );
  return new Set(rows.map((r) => String(r.name)));
}

function migrateFromLegacyIfNeeded() {
  const legacyDbPath = path.join(config.dataDir, "bot.db");
  if (!fs.existsSync(legacyDbPath)) return;

  const settingsPath = getSettingsDbPath();
  const statsPath = getStatsDbPath();
  const moderationPath = getModerationDbPath();
  const normalizedLegacy = path.resolve(legacyDbPath);
  if (
    [settingsPath, statsPath, moderationPath].some(
      (p) => path.resolve(p) === normalizedLegacy,
    )
  ) {
    return;
  }

  let legacy = null;
  try {
    legacy = openDbWithRecovery(legacyDbPath, () => {});
  } catch (err) {
    logger.warn(
      { err, legacyDbPath },
      "Failed opening legacy bot.db for migration",
    );
    return;
  }

  try {
    const legacyChatSettingsColumns = getColumns(legacy, "chat_settings");

    if (
      _settingsState.db &&
      !hasRows(_settingsState.db, "chat_settings") &&
      legacyChatSettingsColumns.size > 0
    ) {
      const chatSettingsRows = queryRows(
        legacy,
        `
        SELECT
          chat_id,
          prompt,
          COALESCE(permission, 0) AS permission,
          ${legacyChatSettingsColumns.has("mode") ? "mode" : `'${DEFAULT_MODE}'`} AS mode,
          ${legacyChatSettingsColumns.has("triggers") ? "triggers" : `'${DEFAULT_TRIGGERS}'`} AS triggers,
          ${legacyChatSettingsColumns.has("llm2_model") ? "llm2_model" : "NULL"} AS llm2_model,
          COALESCE(updated_at, datetime('now')) AS updated_at
        FROM chat_settings
      `,
      );
      runTransaction(_settingsState.db, () => {
        for (const row of chatSettingsRows) {
          _settingsState.db.run(
            `
            INSERT INTO chat_settings (chat_id, prompt, permission, mode, triggers, llm2_model, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(chat_id) DO UPDATE SET
              prompt = excluded.prompt,
              permission = excluded.permission,
              mode = excluded.mode,
              triggers = excluded.triggers,
              llm2_model = excluded.llm2_model,
              updated_at = excluded.updated_at
          `,
            [
              row.chat_id,
              row.prompt,
              row.permission,
              row.mode,
              row.triggers,
              row.llm2_model,
              row.updated_at,
            ],
          );
        }
      });
      logger.info(
        { rows: chatSettingsRows.length },
        "Migrated legacy chat_settings to settings.db",
      );
    }

    if (
      _settingsState.db &&
      !hasRows(_settingsState.db, "llm_models") &&
      tableExists(legacy, "llm_models")
    ) {
      const legacyLlmColumns = getColumns(legacy, "llm_models");
      const hasVisionSupport = legacyLlmColumns.has("vision_support");
      const llmRows = queryRows(
        legacy,
        `
        SELECT model_id, display_name, description, COALESCE(is_active, 1) AS is_active, COALESCE(sort_order, 0) AS sort_order${hasVisionSupport ? ", COALESCE(vision_support, 0) AS vision_support" : ", 0 AS vision_support"}
        FROM llm_models
      `,
      );
      runTransaction(_settingsState.db, () => {
        for (const row of llmRows) {
          _settingsState.db.run(
            `
            INSERT OR REPLACE INTO llm_models (model_id, display_name, description, is_active, sort_order, vision_support)
            VALUES (?, ?, ?, ?, ?, ?)
          `,
            [
              row.model_id,
              row.display_name,
              row.description,
              row.is_active,
              row.sort_order,
              row.vision_support,
            ],
          );
        }
      });
      logger.info(
        { rows: llmRows.length },
        "Migrated legacy llm_models to settings.db",
      );
    }

    if (
      _statsState.db &&
      !hasRows(_statsState.db, "chat_stats") &&
      tableExists(legacy, "chat_stats")
    ) {
      const statRows = queryRows(
        legacy,
        `
        SELECT chat_id, period_type, period_key, stat_key, stat_value
        FROM chat_stats
      `,
      );
      runTransaction(_statsState.db, () => {
        for (const row of statRows) {
          _statsState.db.run(
            `
            INSERT OR REPLACE INTO chat_stats (chat_id, period_type, period_key, stat_key, stat_value)
            VALUES (?, ?, ?, ?, ?)
          `,
            [
              row.chat_id,
              row.period_type,
              row.period_key,
              row.stat_key,
              row.stat_value,
            ],
          );
        }
      });
      logger.info(
        { rows: statRows.length },
        "Migrated legacy chat_stats to stats.db",
      );
    }

    if (
      _statsState.db &&
      !hasRows(_statsState.db, "chat_user_stats") &&
      tableExists(legacy, "chat_user_stats")
    ) {
      const userRows = queryRows(
        legacy,
        `
        SELECT chat_id, period_type, period_key, sender_ref, sender_name, invoke_count
        FROM chat_user_stats
      `,
      );
      runTransaction(_statsState.db, () => {
        for (const row of userRows) {
          _statsState.db.run(
            `
            INSERT OR REPLACE INTO chat_user_stats (chat_id, period_type, period_key, sender_ref, sender_name, invoke_count)
            VALUES (?, ?, ?, ?, ?, ?)
          `,
            [
              row.chat_id,
              row.period_type,
              row.period_key,
              row.sender_ref,
              row.sender_name,
              row.invoke_count,
            ],
          );
        }
      });
      logger.info(
        { rows: userRows.length },
        "Migrated legacy chat_user_stats to stats.db",
      );
    }

    if (
      _moderationState.db &&
      !hasRows(_moderationState.db, "chat_mutes") &&
      tableExists(legacy, "chat_mutes")
    ) {
      const muteRows = queryRows(
        legacy,
        `
        SELECT chat_id, sender_ref, muted_at, duration_m
        FROM chat_mutes
      `,
      );
      runTransaction(_moderationState.db, () => {
        for (const row of muteRows) {
          _moderationState.db.run(
            `
            INSERT OR REPLACE INTO chat_mutes (chat_id, sender_ref, muted_at, duration_m)
            VALUES (?, ?, ?, ?)
          `,
            [row.chat_id, row.sender_ref, row.muted_at, row.duration_m],
          );
        }
      });
      logger.info(
        { rows: muteRows.length },
        "Migrated legacy chat_mutes to moderation.db",
      );
    }
  } catch (err) {
    logger.warn({ err }, "Legacy DB migration skipped due to error");
  } finally {
    closeDb(legacy);
  }
}

async function init() {
  if (
    _settingsState.db &&
    _statsState.db &&
    _moderationState.db &&
    _subagentState.db
  )
    return;

  const settingsPath = getSettingsDbPath();
  const statsPath = getStatsDbPath();
  const moderationPath = getModerationDbPath();
  const subagentPath = getSubagentDbPath();

  replaceDb(_settingsState, initSettingsTables);
  replaceDb(_statsState, initStatsTables);
  replaceDb(_moderationState, initModerationTables);
  replaceDb(_subagentState, initSubagentTables);

  migrateFromLegacyIfNeeded();
  migrateSubagentDbIntoSettings();

  logger.info(
    { settingsPath, statsPath, moderationPath },
    "DB initialized (split)",
  );
}

function migrateSubagentDbIntoSettings() {
  // Pre-fix /subagent on wrote to subagent.db while the Python bridge read
  // from chat_settings.subagent_enabled in settings.db, so existing /subagent
  // on flags were never visible to Python. Backfill into the new source of
  // truth on every boot. The set is upsert-with-OR semantics: a row is only
  // promoted to enabled=1 in chat_settings if it's enabled=1 in subagent.db,
  // never demoted, so manual edits to chat_settings still win on conflict.
  if (!_subagentState.db || !_settingsState.db) return;
  let rows;
  try {
    rows = queryRows(
      _subagentState.db,
      "SELECT chat_id, enabled FROM subagent_enabled",
    );
  } catch (err) {
    logger.warn({ err }, "subagent.db migration: query failed");
    return;
  }
  if (!rows || rows.length === 0) return;
  let migrated = 0;
  try {
    runTransaction(_settingsState.db, () => {
      for (const row of rows) {
        if (row.enabled !== 1) continue;
        _settingsState.db.run(
          `INSERT INTO chat_settings (chat_id, subagent_enabled, updated_at)
           VALUES (?, 1, datetime('now'))
           ON CONFLICT(chat_id) DO UPDATE SET
             subagent_enabled = MAX(chat_settings.subagent_enabled, excluded.subagent_enabled),
             updated_at = excluded.updated_at`,
          [row.chat_id],
        );
        migrated += 1;
      }
    });
  } catch (err) {
    logger.warn({ err }, "subagent.db migration: rollback");
    return;
  }
  if (migrated > 0) {
    logger.info(
      { rows: migrated },
      "Migrated subagent.db rows into chat_settings.subagent_enabled",
    );
  }
}

function runSettingsQuery(sql, ...params) {
  return withDbRecovery(_settingsState, initSettingsTables, () =>
    _settingsState.db.run(sql, params),
  );
}

function getOneFromState(state, initTablesFn, sql, ...params) {
  return withDbRecovery(state, initTablesFn, () => {
    const stmt = state.db.prepare(sql);
    stmt.bind(params);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    }
    stmt.free();
    return null;
  });
}

function getAllFromState(state, initTablesFn, sql, ...params) {
  return withDbRecovery(state, initTablesFn, () => {
    const stmt = state.db.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  });
}

function ensureChatRow(chatId) {
  if (chatId === GLOBAL_CHAT_ID) return;
  // Use INSERT OR IGNORE to avoid UNIQUE constraint violations when concurrent
  // workers (Node + Python) both observe the row is missing and try to insert.
  runSettingsQuery(
    `INSERT OR IGNORE INTO chat_settings
      (chat_id, prompt, permission, mode, triggers, llm2_model,
       subagent_enabled, idle_trigger_min, idle_trigger_max, announcement_enabled, updated_at)
    SELECT ?, prompt, permission, mode, triggers, llm2_model,
           subagent_enabled, idle_trigger_min, idle_trigger_max, announcement_enabled, datetime('now')
    FROM chat_settings WHERE chat_id = ?`,
    chatId,
    GLOBAL_CHAT_ID,
  );
}

function getSettingRow(chatId) {
  let row = getOneFromState(
    _settingsState,
    initSettingsTables,
    "SELECT * FROM chat_settings WHERE chat_id = ?",
    chatId,
  );
  if (!row) {
    row = getOneFromState(
      _settingsState,
      initSettingsTables,
      "SELECT * FROM chat_settings WHERE chat_id = ?",
      GLOBAL_CHAT_ID,
    );
  }
  return row;
}

function getPrompt(chatId) {
  const row = getSettingRow(chatId);
  return row?.prompt ?? null;
}

function setPrompt(chatId, prompt) {
  ensureChatRow(chatId);
  runSettingsQuery(
    "UPDATE chat_settings SET prompt = ?, updated_at = datetime('now') WHERE chat_id = ?",
    prompt,
    chatId,
  );
  logger.info({ chatId, promptLen: prompt?.length || 0 }, "DB set_prompt");
}

function getPermission(chatId) {
  const row = getSettingRow(chatId);
  return row?.permission ?? 0;
}

function setPermission(chatId, level) {
  const clamped = Math.max(0, Math.min(3, parseInt(level, 10) || 0));
  ensureChatRow(chatId);
  runSettingsQuery(
    "UPDATE chat_settings SET permission = ?, updated_at = datetime('now') WHERE chat_id = ?",
    clamped,
    chatId,
  );
  logger.info({ chatId, level: clamped }, "DB set_permission");
}

function getMode(chatId) {
  const row = getSettingRow(chatId);
  let value = row?.mode ?? DEFAULT_MODE;
  if (!VALID_MODES.has(value)) value = DEFAULT_MODE;
  return value;
}

function setMode(chatId, mode) {
  if (!VALID_MODES.has(mode)) mode = DEFAULT_MODE;
  ensureChatRow(chatId);
  runSettingsQuery(
    "UPDATE chat_settings SET mode = ?, updated_at = datetime('now') WHERE chat_id = ?",
    mode,
    chatId,
  );
  logger.info({ chatId, mode }, "DB set_mode");
}

function getTriggers(chatId) {
  const row = getSettingRow(chatId);
  const raw = row?.triggers ?? DEFAULT_TRIGGERS;
  return new Set(
    raw
      .split(",")
      .filter((t) => VALID_TRIGGERS.has(t.trim().toLowerCase()))
      .map((t) => t.trim().toLowerCase()),
  );
}

function setTriggers(chatId, triggers) {
  const valid = [...triggers].filter((t) => VALID_TRIGGERS.has(t));
  const raw = valid.sort().join(",") || "";
  ensureChatRow(chatId);
  runSettingsQuery(
    "UPDATE chat_settings SET triggers = ?, updated_at = datetime('now') WHERE chat_id = ?",
    raw,
    chatId,
  );
  logger.info({ chatId, triggers: raw }, "DB set_triggers");
}

function clearSettings(chatId) {
  runSettingsQuery("DELETE FROM chat_settings WHERE chat_id = ?", chatId);
  logger.info({ chatId }, "DB clear_settings");
}

function getStats(chatId, periodType, periodKey) {
  const rows = getAllFromState(
    _statsState,
    initStatsTables,
    "SELECT stat_key, stat_value FROM chat_stats WHERE chat_id = ? AND period_type = ? AND period_key = ?",
    chatId,
    periodType,
    periodKey,
  );
  const result = {};
  for (const row of rows) result[row.stat_key] = row.stat_value;
  return result;
}

function getTopUsers(chatId, periodType, periodKey, limit = 5) {
  const rows = getAllFromState(
    _statsState,
    initStatsTables,
    `SELECT sender_ref, sender_name, invoke_count FROM chat_user_stats
     WHERE chat_id = ? AND period_type = ? AND period_key = ?
     ORDER BY invoke_count DESC LIMIT ?`,
    chatId,
    periodType,
    periodKey,
    limit,
  );
  return rows.map((row) => ({
    senderRef: row.sender_ref,
    senderName: row.sender_name,
    invokeCount: row.invoke_count,
  }));
}

function getDefaultLlm2Model() {
  const row = getOneFromState(
    _settingsState,
    initSettingsTables,
    "SELECT model_id, display_name, description, vision_support FROM llm_models WHERE is_active = 1 ORDER BY sort_order ASC LIMIT 1",
  );
  if (row)
    return {
      modelId: row.model_id,
      displayName: row.display_name,
      description: row.description,
      visionSupport: Boolean(row.vision_support),
    };
  return null;
}

function getLlm2Model(chatId) {
  const row = getSettingRow(chatId);
  return row?.llm2_model ?? null;
}

function setLlm2Model(chatId, modelId) {
  ensureChatRow(chatId);
  runSettingsQuery(
    "UPDATE chat_settings SET llm2_model = ?, updated_at = datetime('now') WHERE chat_id = ?",
    modelId,
    chatId,
  );
  logger.info({ chatId, modelId }, "DB set_llm2_model");
}

function getAllActiveModels() {
  const rows = getAllFromState(
    _settingsState,
    initSettingsTables,
    "SELECT model_id, display_name, description, sort_order, vision_support FROM llm_models WHERE is_active = 1 ORDER BY sort_order ASC",
  );
  return rows.map((row) => ({
    modelId: row.model_id,
    displayName: row.display_name,
    description: row.description,
    sortOrder: row.sort_order,
    visionSupport: Boolean(row.vision_support),
  }));
}

function getAllModels() {
  const rows = getAllFromState(
    _settingsState,
    initSettingsTables,
    "SELECT model_id, display_name, description, is_active, sort_order, vision_support FROM llm_models ORDER BY sort_order ASC",
  );
  return rows.map((row) => ({
    modelId: row.model_id,
    displayName: row.display_name,
    description: row.description,
    isActive: Boolean(row.is_active),
    sortOrder: row.sort_order,
    visionSupport: Boolean(row.vision_support),
  }));
}

function addModel(
  modelId,
  displayName,
  description = "",
  sortOrder = null,
  visionSupport = false,
) {
  if (sortOrder === null) {
    const maxOrder = getOneFromState(
      _settingsState,
      initSettingsTables,
      "SELECT MAX(sort_order) as max_order FROM llm_models",
    );
    sortOrder = (maxOrder?.max_order ?? -1) + 1;
  }
  try {
    runSettingsQuery(
      "INSERT INTO llm_models (model_id, display_name, description, sort_order, vision_support) VALUES (?, ?, ?, ?, ?)",
      modelId,
      displayName,
      description,
      sortOrder,
      visionSupport ? 1 : 0,
    );
    logger.info({ modelId, displayName, visionSupport }, "DB add_model");
    return true;
  } catch (err) {
    if (
      err.message?.includes("UNIQUE constraint failed") ||
      err.code === "SQLITE_CONSTRAINT_PRIMARYKEY"
    )
      return false;
    throw err;
  }
}

function updateModel(
  modelId,
  { displayName, description, isActive, sortOrder, visionSupport } = {},
) {
  const existing = getOneFromState(
    _settingsState,
    initSettingsTables,
    "SELECT model_id FROM llm_models WHERE model_id = ?",
    modelId,
  );
  if (!existing) return false;
  const updates = [];
  const values = [];
  if (displayName !== undefined) {
    updates.push("display_name = ?");
    values.push(displayName);
  }
  if (description !== undefined) {
    updates.push("description = ?");
    values.push(description);
  }
  if (isActive !== undefined) {
    updates.push("is_active = ?");
    values.push(isActive ? 1 : 0);
  }
  if (sortOrder !== undefined) {
    updates.push("sort_order = ?");
    values.push(sortOrder);
  }
  if (visionSupport !== undefined) {
    updates.push("vision_support = ?");
    values.push(visionSupport ? 1 : 0);
  }
  if (updates.length === 0) return true;
  values.push(modelId);
  runSettingsQuery(
    `UPDATE llm_models SET ${updates.join(", ")} WHERE model_id = ?`,
    ...values,
  );
  logger.info({ modelId }, "DB update_model");
  return true;
}

function deleteModel(modelId) {
  const existing = getOneFromState(
    _settingsState,
    initSettingsTables,
    "SELECT model_id FROM llm_models WHERE model_id = ?",
    modelId,
  );
  if (!existing) return { success: false, affectedChatIds: [] };
  const affectedRows = getAllFromState(
    _settingsState,
    initSettingsTables,
    "SELECT chat_id FROM chat_settings WHERE llm2_model = ?",
    modelId,
  );
  const affectedChatIds = affectedRows.map((r) => r.chat_id);
  runSettingsQuery("DELETE FROM llm_models WHERE model_id = ?", modelId);
  runSettingsQuery(
    "UPDATE chat_settings SET llm2_model = NULL WHERE llm2_model = ?",
    modelId,
  );
  logger.info({ modelId, affectedChatIds }, "DB delete_model");
  return { success: true, affectedChatIds };
}

function getOwnerContact() {
  const row = getOneFromState(
    _settingsState,
    initSettingsTables,
    "SELECT phone_number, display_name FROM owner_contact WHERE id = 1",
  );
  if (!row) return null;
  return { phoneNumber: row.phone_number, displayName: row.display_name };
}

function setOwnerContact(phoneNumber, displayName) {
  runSettingsQuery(
    `
    INSERT INTO owner_contact (id, phone_number, display_name, updated_at)
    VALUES (1, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      phone_number = excluded.phone_number,
      display_name = excluded.display_name,
      updated_at = excluded.updated_at
  `,
    phoneNumber,
    displayName,
  );
  logger.info({ phoneNumber, displayName }, "DB set_owner_contact");
}

function getSubagentEnabled(chatId) {
  const row = getSettingRow(chatId);
  return row?.subagent_enabled === 1;
}

function setSubagentEnabled(chatId, enabled) {
  const value = enabled ? 1 : 0;
  ensureChatRow(chatId);
  runSettingsQuery(
    "UPDATE chat_settings SET subagent_enabled = ?, updated_at = datetime('now') WHERE chat_id = ?",
    value,
    chatId,
  );
  logger.info({ chatId, enabled: value }, "DB set_subagent_enabled");
}

function setGlobalPrompt(prompt) {
  runSettingsQuery(
    "UPDATE chat_settings SET prompt = ?, updated_at = datetime('now')",
    prompt,
  );
  logger.info({ promptLen: prompt?.length || 0 }, "DB set_global_prompt");
}

function setGlobalPermission(level) {
  const clamped = Math.max(0, Math.min(3, parseInt(level, 10) || 0));
  runSettingsQuery(
    "UPDATE chat_settings SET permission = ?, updated_at = datetime('now')",
    clamped,
  );
  logger.info({ level: clamped }, "DB set_global_permission");
}

function setGlobalMode(mode) {
  if (!VALID_MODES.has(mode)) mode = DEFAULT_MODE;
  runSettingsQuery(
    "UPDATE chat_settings SET mode = ?, updated_at = datetime('now')",
    mode,
  );
  logger.info({ mode }, "DB set_global_mode");
}

function setGlobalTriggers(triggers) {
  const valid = [...triggers].filter((t) => VALID_TRIGGERS.has(t));
  const raw = valid.sort().join(",") || "";
  runSettingsQuery(
    "UPDATE chat_settings SET triggers = ?, updated_at = datetime('now')",
    raw,
  );
  logger.info({ triggers: raw }, "DB set_global_triggers");
}

function setGlobalLlm2Model(modelId) {
  runSettingsQuery(
    "UPDATE chat_settings SET llm2_model = ?, updated_at = datetime('now')",
    modelId,
  );
  logger.info({ modelId }, "DB set_global_llm2_model");
}

function setGlobalSubagentEnabled(enabled) {
  const value = enabled ? 1 : 0;
  runSettingsQuery(
    "UPDATE chat_settings SET subagent_enabled = ?, updated_at = datetime('now')",
    value,
  );
  logger.info({ enabled: value }, "DB set_global_subagent_enabled");
}

function getIdleTrigger(chatId) {
  const row = getSettingRow(chatId);
  const min = row?.idle_trigger_min ?? null;
  const max = row?.idle_trigger_max ?? null;
  if (min == null) return null;
  return { min, max: max ?? min };
}

function setIdleTrigger(chatId, min, max) {
  ensureChatRow(chatId);
  runSettingsQuery(
    "UPDATE chat_settings SET idle_trigger_min = ?, idle_trigger_max = ?, updated_at = datetime('now') WHERE chat_id = ?",
    min,
    max,
    chatId,
  );
  logger.info({ chatId, min, max }, "DB set_idle_trigger");
}

function setGlobalIdleTrigger(min, max) {
  runSettingsQuery(
    "UPDATE chat_settings SET idle_trigger_min = ?, idle_trigger_max = ?, updated_at = datetime('now')",
    min,
    max,
  );
  logger.info({ min, max }, "DB set_global_idle_trigger");
}

function getAnnouncementEnabled(chatId) {
  const row = getSettingRow(chatId);
  return row?.announcement_enabled !== 0;
}

function setAnnouncementEnabled(chatId, enabled) {
  const value = enabled ? 1 : 0;
  ensureChatRow(chatId);
  runSettingsQuery(
    "UPDATE chat_settings SET announcement_enabled = ?, updated_at = datetime('now') WHERE chat_id = ?",
    value,
    chatId,
  );
  logger.info({ chatId, enabled: value }, "DB set_announcement_enabled");
}

function setGlobalAnnouncementEnabled(enabled) {
  const value = enabled ? 1 : 0;
  runSettingsQuery(
    "UPDATE chat_settings SET announcement_enabled = ?, updated_at = datetime('now')",
    value,
  );
  logger.info({ enabled: value }, "DB set_global_announcement_enabled");
}

// ---------------------------------------------------------------------------
// Activation code management
// ---------------------------------------------------------------------------

function generateActivationCode(type, days, createdBy) {
  const validTypes = new Set(["private", "group", "all"]);
  if (!validTypes.has(type)) {
    throw new Error(`Invalid activation type: ${type}`);
  }
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "WA-";
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  const daysInt = Math.max(0, Math.floor(days));
  ensureSettingsDbReady();
  _settingsState.db.run(
    `INSERT INTO activation_codes (code, type, days, created_by) VALUES (?, ?, ?, ?)`,
    [code, type, daysInt, createdBy],
  );
  const row = queryRows(
    _settingsState.db,
    "SELECT id, code, type, days, created_at, created_by FROM activation_codes WHERE code = ?",
    code,
  );
  if (row.length === 0) {
    throw new Error("Failed to retrieve generated activation code");
  }
  logger.info({ id: row[0].id, code, type, days: daysInt, createdBy }, "DB generate_activation_code");
  return {
    id: row[0].id,
    code: row[0].code,
    type: row[0].type,
    days: row[0].days,
    createdAt: row[0].created_at,
    createdBy: row[0].created_by,
  };
}

function activateChat(chatId, code, chatType) {
  ensureSettingsDbReady();
  const codeRows = queryRows(
    _settingsState.db,
    "SELECT id, code, type, days, used, used_by, created_at, created_by FROM activation_codes WHERE code = ?",
    code.toUpperCase(),
  );
  if (codeRows.length === 0) {
    return { success: false, message: "Kode aktivasi tidak ditemukan." };
  }
  const codeRow = codeRows[0];
  if (codeRow.used) {
    return { success: false, message: "Kode aktivasi sudah digunakan." };
  }
  const codeType = codeRow.type;
  if (codeType !== "all") {
    const expected = chatType === "group" ? "group" : "private";
    if (codeType !== expected) {
      return { success: false, message: `Kode ini hanya untuk ${codeType === "group" ? "grup" : "chat privat"}.` };
    }
  }
  runSettingsQuery(
    "UPDATE activation_codes SET used = 1, used_by = ? WHERE code = ?",
    chatId,
    code.toUpperCase(),
  );
  const existingRows = queryRows(
    _settingsState.db,
    "SELECT chat_id, code, activated_at, expires_at FROM chat_activations WHERE chat_id = ?",
    chatId,
  );
  const daysInt = codeRow.days;
  let expiresAt = null;
  const now = new Date();
  if (daysInt > 0) {
    if (existingRows.length > 0 && existingRows[0].expires_at) {
      const currentExpiry = new Date(existingRows[0].expires_at);
      const baseDate = currentExpiry > now ? currentExpiry : now;
      expiresAt = new Date(baseDate.getTime() + daysInt * 86400000)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19);
    } else {
      expiresAt = new Date(now.getTime() + daysInt * 86400000)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19);
    }
  } else {
    expiresAt = null;
  }

  if (existingRows.length > 0) {
    runSettingsQuery(
      "UPDATE chat_activations SET code = ?, activated_at = datetime('now'), expires_at = ?, expiry_notified = 0 WHERE chat_id = ?",
      code.toUpperCase(),
      expiresAt,
      chatId,
    );
  } else {
    runSettingsQuery(
      "INSERT INTO chat_activations (chat_id, code, activated_at, expires_at) VALUES (?, ?, datetime('now'), ?)",
      chatId,
      code.toUpperCase(),
      expiresAt,
    );
  }
  logger.info({ chatId, code: code.toUpperCase(), days: daysInt, expiresAt }, "DB activate_chat");
  if (daysInt === 0) {
    return { success: true, message: "Aktivasi berhasil! Chat ini sekarang aktif secara permanen.", expiresAt: null };
  }
  return { success: true, message: `Aktivasi berhasil! Chat ini aktif selama ${daysInt} hari.`, expiresAt };
}

function isChatActivated(chatId) {
  ensureSettingsDbReady();
  const rows = queryRows(
    _settingsState.db,
    "SELECT chat_id, expires_at FROM chat_activations WHERE chat_id = ?",
    chatId,
  );
  if (rows.length === 0) return false;
  const expiresAt = rows[0].expires_at;
  if (expiresAt === null || expiresAt === undefined) return true;
  return new Date(expiresAt) > new Date();
}

function getChatActivation(chatId) {
  ensureSettingsDbReady();
  const rows = queryRows(
    _settingsState.db,
    "SELECT chat_id, code, activated_at, expires_at, expiry_notified FROM chat_activations WHERE chat_id = ?",
    chatId,
  );
  if (rows.length === 0) return null;
  return {
    chatId: rows[0].chat_id,
    code: rows[0].code,
    activatedAt: rows[0].activated_at,
    expiresAt: rows[0].expires_at,
    expiryNotified: rows[0].expiry_notified === 1,
  };
}

function getAllActivationCodes() {
  ensureSettingsDbReady();
  return queryRows(
    _settingsState.db,
    "SELECT id, code, type, days, used, used_by, created_at, created_by FROM activation_codes ORDER BY id ASC",
  ).map((row) => ({
    id: row.id,
    code: row.code,
    type: row.type,
    days: row.days,
    used: row.used === 1,
    usedBy: row.used_by,
    createdAt: row.created_at,
    createdBy: row.created_by,
  }));
}

function getAllActivations() {
  ensureSettingsDbReady();
  return queryRows(
    _settingsState.db,
    "SELECT chat_id, code, activated_at, expires_at, expiry_notified FROM chat_activations ORDER BY activated_at ASC",
  ).map((row) => ({
    chatId: row.chat_id,
    code: row.code,
    activatedAt: row.activated_at,
    expiresAt: row.expires_at,
    expiryNotified: row.expiry_notified === 1,
  }));
}

function revokeActivationCode(id) {
  ensureSettingsDbReady();
  const rows = queryRows(
    _settingsState.db,
    "SELECT id, code, used, used_by FROM activation_codes WHERE id = ?",
    id,
  );
  if (rows.length === 0) {
    return { success: false, message: "Kode aktivasi tidak ditemukan." };
  }
  const codeRow = rows[0];
  const wasUsed = codeRow.used === 1;
  const usedBy = codeRow.used_by;
  runSettingsQuery("DELETE FROM activation_codes WHERE id = ?", id);
  if (wasUsed) {
    runSettingsQuery("DELETE FROM chat_activations WHERE code = ?", codeRow.code);
  }
  logger.info({ id, code: codeRow.code, wasUsed, usedBy }, "DB revoke_activation_code");
  return { success: true, message: "Kode aktivasi dicabut.", wasUsed, usedBy };
}

function markExpiryNotified(chatId) {
  ensureSettingsDbReady();
  runSettingsQuery(
    "UPDATE chat_activations SET expiry_notified = 1 WHERE chat_id = ?",
    chatId,
  );
}

function isExpiryNotified(chatId) {
  ensureSettingsDbReady();
  const rows = queryRows(
    _settingsState.db,
    "SELECT expiry_notified FROM chat_activations WHERE chat_id = ?",
    chatId,
  );
  if (rows.length === 0) return false;
  return rows[0].expiry_notified === 1;
}

function ensureSettingsDbReady() {
  if (!_settingsState.db) {
    throw new Error("Settings DB not initialized");
  }
}

function getDbPath() {
  return getSettingsDbPath();
}

export {
  init,
  getDbPath,
  getSettingsDbPath,
  getStatsDbPath,
  getModerationDbPath,
  getSubagentDbPath,
  getPrompt,
  setPrompt,
  getPermission,
  setPermission,
  getMode,
  setMode,
  getTriggers,
  setTriggers,
  clearSettings,
  getStats,
  getTopUsers,
  getLlm2Model,
  setLlm2Model,
  getAllActiveModels,
  getAllModels,
  getDefaultLlm2Model,
  addModel,
  updateModel,
  deleteModel,
  getOwnerContact,
  setOwnerContact,
  getSubagentEnabled,
  setSubagentEnabled,
  setGlobalPrompt,
  setGlobalPermission,
  setGlobalMode,
  setGlobalTriggers,
  setGlobalLlm2Model,
  setGlobalSubagentEnabled,
  getIdleTrigger,
  setIdleTrigger,
  setGlobalIdleTrigger,
  getAnnouncementEnabled,
  setAnnouncementEnabled,
  setGlobalAnnouncementEnabled,
  generateActivationCode,
  activateChat,
  isChatActivated,
  getChatActivation,
  getAllActivationCodes,
  getAllActivations,
  revokeActivationCode,
  markExpiryNotified,
  isExpiryNotified,
  closeAllDbs,
  VALID_MODES,
  DEFAULT_MODE,
  VALID_TRIGGERS,
  DEFAULT_TRIGGERS,
};
