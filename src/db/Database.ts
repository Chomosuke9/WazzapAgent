// Connection-owner aggregate for one tenant's four logical SQLite databases
// (settings, stats, moderation, subagent).
//
// Extracted verbatim from the original src/db.ts (Step 03 structural split):
// the low-level better-sqlite3 wrapper, WAL setup, recovery/probeDb/replaceDb
// logic, and the legacy/subagent migrations now live here behind a `Database`
// class. No SQL semantics, table shapes, recovery behavior, or migration logic
// changed. src/db.ts keeps a single process-wide instance as a temporary shim
// (removed in step-05).

import BetterSqlite3 from "better-sqlite3";
import path from "path";
import fs from "fs";
import logger from "../logger.js";
import config from "../config.js";
import {
  DEFAULT_MODE,
  DEFAULT_TRIGGERS,
  queryRows,
  tableExists,
  hasRows,
  getColumns,
  initSettingsTables,
  initStatsTables,
  initModerationTables,
  initSubagentTables,
} from "./schema/index.js";

// ---------------------------------------------------------------------------
// Per-DB state + row shapes owned by the connection layer
// ---------------------------------------------------------------------------

interface DbState {
  db: SqliteDb | null;
  dbPath: string | null;
}

interface SubagentEnabledRow {
  chat_id: string;
  enabled: number;
}

type RetryFn = <T>(fn: () => T) => T;

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

const SQLITE_BUSY_TIMEOUT_MS = parsePositiveIntEnv("DB_BUSY_TIMEOUT_MS", 30000);
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

const DB_CORRUPTION_TOKENS = [
  "malformed",
  "disk image is malformed",
  "not a database",
  "file is not a database",
  "file is encrypted",
  "database corruption",
];

function noop(..._args: unknown[]): void {}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function normalizeParams(params: unknown): unknown[] {
  if (params === undefined || params === null) return [];
  return Array.isArray(params) ? params : [params];
}

// ---------------------------------------------------------------------------
// better-sqlite3 wrapper + statement adapter
// ---------------------------------------------------------------------------

class SqliteStatement {
  stmt: BetterSqlite3.Statement;
  retryFn: RetryFn;
  params: unknown[];
  rows: Record<string, unknown>[] | null;
  index: number;

  constructor(stmt: BetterSqlite3.Statement, retryFn: RetryFn) {
    this.stmt = stmt;
    this.retryFn = retryFn;
    this.params = [];
    this.rows = null;
    this.index = 0;
  }

  bind(params: unknown): void {
    this.params = normalizeParams(params);
    this.rows = null;
    this.index = 0;
  }

  step(): boolean {
    if (this.rows === null) {
      this.rows = this.retryFn(
        () => this.stmt.all(...this.params) as Record<string, unknown>[],
      );
    }
    return this.index < this.rows.length;
  }

  getAsObject(): Record<string, unknown> {
    if (this.rows === null) {
      this.rows = this.retryFn(
        () => this.stmt.all(...this.params) as Record<string, unknown>[],
      );
    }
    const row = this.rows[this.index];
    this.index += 1;
    return row;
  }

  free(): void {
    this.rows = null;
  }
}

class SqliteDb {
  dbPath: string;
  native: BetterSqlite3.Database;

  constructor(dbPath: string, options: BetterSqlite3.Options = {}) {
    this.dbPath = dbPath;
    this.native = new BetterSqlite3(dbPath, {
      timeout: SQLITE_BUSY_TIMEOUT_MS,
      ...options,
    });
  }

  run(sql: string, params?: unknown): void {
    return retrySqliteOperation(() => {
      const values = normalizeParams(params);
      if (values.length === 0) {
        this.native.exec(sql);
        return;
      }
      this.native.prepare(sql).run(...values);
    });
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(
      retrySqliteOperation(() => this.native.prepare(sql)),
      retrySqliteOperation,
    );
  }

  pragma(sql: string): unknown {
    return retrySqliteOperation(() => this.native.pragma(sql));
  }

  close(): void {
    this.native.close();
  }
}

function runTransaction<T>(db: SqliteDb, fn: () => T): T {
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

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function configureDb(db: SqliteDb): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  db.pragma("wal_autocheckpoint = 1000");
  db.pragma("journal_size_limit = 67108864");
  db.pragma("temp_store = MEMORY");
  db.pragma("foreign_keys = ON");
  db.pragma("cache_size = -4000");
}

function closeDb(db: SqliteDb | null): void {
  if (!db) return;
  try {
    db.close();
  } catch (err) {
    noop(err);
  }
}

function isDbCorruptionError(err: any): boolean {
  const msg = String(err?.message || err || "").toLowerCase();
  return DB_CORRUPTION_TOKENS.some((token) => msg.includes(token));
}

/**
 * Run a synchronous better-sqlite3 operation.
 *
 * better-sqlite3 is synchronous, so every call blocks the event loop for its
 * duration. SQLite's own `busy_timeout` (set to {@link SQLITE_BUSY_TIMEOUT_MS}
 * on every connection via both the constructor `timeout` and
 * `PRAGMA busy_timeout`) is the canonical wait-for-lock mechanism: it parks on a
 * contended lock and retries internally, only throwing `SQLITE_BUSY` once the
 * timeout elapses.
 *
 * The previous implementation layered a manual exponential-backoff retry ON TOP
 * of that — each attempt re-ran the operation (re-waiting the full
 * busy_timeout) and slept between tries with `Atomics.wait`, which blocks the
 * ENTIRE event loop (freezing every tenant and the WS heartbeats) for up to
 * ~retries × busy_timeout. We now rely on busy_timeout alone: the worst-case
 * block is a single timeout window, with no event-loop-blocking sleeps on the
 * hot path. Operators who need a shorter freeze can lower `DB_BUSY_TIMEOUT_MS`.
 *
 * Kept as a single-call wrapper (rather than inlined) so the `RetryFn` seam and
 * call sites stay unchanged.
 */
function retrySqliteOperation<T>(fn: () => T): T {
  return fn();
}

function backupCorruptFile(dbPath: string): string | null {
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

function probeDb(dbPath: string): boolean {
  if (!fs.existsSync(dbPath)) return true;
  let db: SqliteDb | null = null;
  try {
    db = new SqliteDb(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.pragma("integrity_check") as Array<{
      integrity_check: string;
    }>;
    return rows.length > 0 && rows.every((row) => row.integrity_check === "ok");
  } catch (err) {
    return false;
  } finally {
    closeDb(db);
  }
}

function withRecoveryLock<T>(dbPath: string, fn: () => T): T {
  const lockPath = `${dbPath}.recover.lock`;
  const deadline = Date.now() + SQLITE_RECOVERY_LOCK_WAIT_MS;
  let fd: number | null = null;
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
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > SQLITE_RECOVERY_LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (statErr: any) {
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

function recoverCorruptDb(dbPath: string): void {
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

function openDbWithRecovery(
  dbPath: string,
  initTablesFn: (db: SqliteDb) => void,
): SqliteDb {
  let db: SqliteDb | null = null;
  try {
    db = new SqliteDb(dbPath);
    configureDb(db);
    const rows = db.pragma("quick_check") as Array<{ quick_check: string }>;
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
    const rows = db.pragma("quick_check") as Array<{ quick_check: string }>;
    if (!rows.every((row) => row.quick_check === "ok")) {
      throw new Error("database disk image is malformed");
    }
    initTablesFn(db);
    return db;
  }
}

function replaceDb(
  state: DbState,
  initTablesFn: (db: SqliteDb) => void,
): void {
  closeDb(state.db);
  state.db = openDbWithRecovery(state.dbPath as string, initTablesFn);
}

function recoverStateAfterCorruption(
  state: DbState,
  initTablesFn: (db: SqliteDb) => void,
  err: unknown,
): void {
  closeDb(state.db);
  state.db = null;
  logger.warn(
    { err, dbPath: state.dbPath },
    "DB corruption detected during query; recovering",
  );
  recoverCorruptDb(state.dbPath as string);
  replaceDb(state, initTablesFn);
}

function withDbRecovery<T>(
  state: DbState,
  initTablesFn: (db: SqliteDb) => void,
  fn: () => T,
): T {
  try {
    return fn();
  } catch (err) {
    if (!isDbCorruptionError(err)) throw err;
    recoverStateAfterCorruption(state, initTablesFn, err);
    return fn();
  }
}

// ---------------------------------------------------------------------------
// Database — connection-owner for one tenant's four logical DBs
// ---------------------------------------------------------------------------

class Database {
  readonly settingsState: DbState = { db: null, dbPath: null };
  readonly statsState: DbState = { db: null, dbPath: null };
  readonly moderationState: DbState = { db: null, dbPath: null };
  readonly subagentState: DbState = { db: null, dbPath: null };

  /**
   * Tenant `db/` directory this instance owns, or `null` for the legacy global
   * layout (`config.*DbPath`). Each {@link import('../../protocol/types.js').AccountEntry}
   * constructs ONE `Database` pointed at its own `<folderPath>/db` dir, so two
   * tenants never share connections (CONTRACT.md §8). When `null`, paths fall
   * back to the global `config.*DbPath` so the default single-account boot is
   * unchanged from the user's perspective.
   */
  private readonly dbDir: string | null;

  constructor(dbDir?: string | null) {
    this.dbDir = dbDir ?? null;
  }

  getSettingsDbPath(): string {
    if (this.settingsState.dbPath) return this.settingsState.dbPath;
    this.settingsState.dbPath = this.dbDir
      ? path.join(this.dbDir, "settings.db")
      : config.settingsDbPath;
    ensureParentDir(this.settingsState.dbPath);
    return this.settingsState.dbPath;
  }

  getStatsDbPath(): string {
    if (this.statsState.dbPath) return this.statsState.dbPath;
    this.statsState.dbPath = this.dbDir
      ? path.join(this.dbDir, "stats.db")
      : config.statsDbPath;
    ensureParentDir(this.statsState.dbPath);
    return this.statsState.dbPath;
  }

  getModerationDbPath(): string {
    if (this.moderationState.dbPath) return this.moderationState.dbPath;
    this.moderationState.dbPath = this.dbDir
      ? path.join(this.dbDir, "moderation.db")
      : config.moderationDbPath;
    ensureParentDir(this.moderationState.dbPath);
    return this.moderationState.dbPath;
  }

  getSubagentDbPath(): string {
    if (this.subagentState.dbPath) return this.subagentState.dbPath;
    this.subagentState.dbPath = this.dbDir
      ? path.join(this.dbDir, "subagent.db")
      : config.subagentDbPath;
    ensureParentDir(this.subagentState.dbPath);
    return this.subagentState.dbPath;
  }

  /**
   * Open this instance's four split SQLite databases under its own tenant
   * `db/` directory (or the global `config.*DbPath` locations when constructed
   * without a `dbDir`).
   *
   * Step 05: this is the per-account open that replaces the old module-global
   * global init / path-injecting opens. There is intentionally NO early-return guard —
   * the bug that guard caused (a second tenant silently reusing the first
   * tenant's already-open handles) is impossible now that ownership is the
   * `AccountEntry`. `replaceDb` closes any prior handle before reopening, so a
   * repeated `open()` on the same instance is still safe.
   */
  open(): void {
    const settingsPath = this.getSettingsDbPath();
    const statsPath = this.getStatsDbPath();
    const moderationPath = this.getModerationDbPath();
    this.getSubagentDbPath();

    replaceDb(this.settingsState, initSettingsTables);
    replaceDb(this.statsState, initStatsTables);
    replaceDb(this.moderationState, initModerationTables);
    replaceDb(this.subagentState, initSubagentTables);

    this.migrateFromLegacyIfNeeded();
    this.migrateSubagentDbIntoSettings();

    logger.info(
      { settingsPath, statsPath, moderationPath, dbDir: this.dbDir },
      "DB initialized (per-account)",
    );
  }

  close(): void {
    const states = [
      this.settingsState,
      this.statsState,
      this.moderationState,
      this.subagentState,
    ];
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

  migrateFromLegacyIfNeeded(): void {
    const legacyDbPath = path.join(config.dataDir, "bot.db");
    if (!fs.existsSync(legacyDbPath)) return;

    const settingsPath = this.getSettingsDbPath();
    const statsPath = this.getStatsDbPath();
    const moderationPath = this.getModerationDbPath();
    const normalizedLegacy = path.resolve(legacyDbPath);
    if (
      [settingsPath, statsPath, moderationPath].some(
        (p) => path.resolve(p) === normalizedLegacy,
      )
    ) {
      return;
    }

    let legacy: SqliteDb | null = null;
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
      const legacyChatSettingsColumns = getColumns(legacy!, "chat_settings");

      if (
        this.settingsState.db &&
        !hasRows(this.settingsState.db, "chat_settings") &&
        legacyChatSettingsColumns.size > 0
      ) {
        const chatSettingsRows = queryRows(
          legacy!,
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
        runTransaction(this.settingsState.db, () => {
          for (const row of chatSettingsRows) {
            this.settingsState.db!.run(
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
        this.settingsState.db &&
        !hasRows(this.settingsState.db, "llm_models") &&
        tableExists(legacy!, "llm_models")
      ) {
        const legacyLlmColumns = getColumns(legacy!, "llm_models");
        const hasVisionSupport = legacyLlmColumns.has("vision_support");
        const llmRows = queryRows(
          legacy!,
          `
          SELECT model_id, display_name, description, COALESCE(is_active, 1) AS is_active, COALESCE(sort_order, 0) AS sort_order${hasVisionSupport ? ", COALESCE(vision_support, 0) AS vision_support" : ", 0 AS vision_support"}
          FROM llm_models
        `,
        );
        runTransaction(this.settingsState.db, () => {
          for (const row of llmRows) {
            this.settingsState.db!.run(
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
        this.statsState.db &&
        !hasRows(this.statsState.db, "chat_stats") &&
        tableExists(legacy!, "chat_stats")
      ) {
        const statRows = queryRows(
          legacy!,
          `
          SELECT chat_id, period_type, period_key, stat_key, stat_value
          FROM chat_stats
        `,
        );
        runTransaction(this.statsState.db, () => {
          for (const row of statRows) {
            this.statsState.db!.run(
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
        this.statsState.db &&
        !hasRows(this.statsState.db, "chat_user_stats") &&
        tableExists(legacy!, "chat_user_stats")
      ) {
        const userRows = queryRows(
          legacy!,
          `
          SELECT chat_id, period_type, period_key, sender_ref, sender_name, invoke_count
          FROM chat_user_stats
        `,
        );
        runTransaction(this.statsState.db, () => {
          for (const row of userRows) {
            this.statsState.db!.run(
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
        this.moderationState.db &&
        !hasRows(this.moderationState.db, "chat_mutes") &&
        tableExists(legacy!, "chat_mutes")
      ) {
        const muteRows = queryRows(
          legacy!,
          `
          SELECT chat_id, sender_ref, muted_at, duration_m
          FROM chat_mutes
        `,
        );
        runTransaction(this.moderationState.db, () => {
          for (const row of muteRows) {
            this.moderationState.db!.run(
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

  migrateSubagentDbIntoSettings(): void {
    // Pre-fix /subagent on wrote to subagent.db while the Python bridge read
    // from chat_settings.subagent_enabled in settings.db, so existing /subagent
    // on flags were never visible to Python. Backfill into the new source of
    // truth on every boot. The set is upsert-with-OR semantics: a row is only
    // promoted to enabled=1 in chat_settings if it's enabled=1 in subagent.db,
    // never demoted, so manual edits to chat_settings still win on conflict.
    if (!this.subagentState.db || !this.settingsState.db) return;
    let rows: SubagentEnabledRow[];
    try {
      rows = queryRows<SubagentEnabledRow>(
        this.subagentState.db,
        "SELECT chat_id, enabled FROM subagent_enabled",
      );
    } catch (err) {
      logger.warn({ err }, "subagent.db migration: query failed");
      return;
    }
    if (!rows || rows.length === 0) return;
    let migrated = 0;
    try {
      runTransaction(this.settingsState.db, () => {
        for (const row of rows) {
          if (row.enabled !== 1) continue;
          this.settingsState.db!.run(
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
}

export {
  Database,
  SqliteDb,
  SqliteStatement,
  withDbRecovery,
  runTransaction,
  ensureParentDir,
};
export type { DbState, RetryFn };
