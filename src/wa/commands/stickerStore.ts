/**
 * stickerStore.ts — shared persistence for the user sticker catalog (stickers.db).
 *
 * PATH PARITY WITH PYTHON (the bug this module fixes):
 *   The Python bridge (python/bridge/sticker_db.py) resolves the catalog DB to
 *   `<folderPath>/db/stickers.db` — the per-tenant `db/` dir (CONTRACT.md §8) —
 *   because every AgentSession binds its tenant via `set_tenant_db_dir()`
 *   (session.py). The catalog the LLM sees is read by Python from THAT file.
 *
 *   The Node `/add-sticker` + `/remove-sticker` commands therefore MUST write
 *   to the same `<folderPath>/db/stickers.db`. They previously wrote to the
 *   flat `config.stickersDbPath` (`<DATA_DIR>/stickers.db`, no `/db`), so a
 *   sticker added on the Node side never appeared in the Python-read catalog.
 *   Node's own `Database` class (src/db/Database.ts) already resolves every
 *   other DB as `path.join(folderPath, "db", "<name>.db")` — this mirrors it.
 *
 * MULTI-TENANT SAFETY:
 *   Connections are cached per RESOLVED path, so a multi-account Node process
 *   keeps one independent handle per tenant with no cross-talk (mirrors the
 *   per-path connection cache in sticker_db.py). The previous module-level
 *   singleton would have served the first tenant's DB to every account.
 */
import path from "path";
import fs from "fs-extra";
import Database from "better-sqlite3";
type StickerDatabase = InstanceType<typeof Database>;
import config from "../../config.js";
import { parseConfigScope, type ConfigScope } from "./configScope.js";

// Must match GLOBAL_STICKER_CHAT_ID in Python's sticker_db.py.
export const GLOBAL_STICKER_CHAT_ID = "__global__";

// Name validation — must match Python's `_NAME_RE` in sticker_db.py.
export const STICKER_NAME_RE = /^[a-z0-9_\-]{1,64}$/;

/**
 * Resolve this tenant's sticker catalog DB path: `<folderPath>/db/stickers.db`.
 * Falls back to the legacy global `config.stickersDbPath` only when no tenant
 * folder is known (mirrors the `dbDir ?? config.*DbPath` fallback in
 * src/db/Database.ts; in practice `CommandContext.folderPath` is always set).
 */
export function stickerDbPath(folderPath: string | null | undefined): string {
  if (folderPath && folderPath.trim()) {
    return path.join(folderPath, "db", "stickers.db");
  }
  return config.stickersDbPath;
}

// Per-resolved-path connection cache (one handle per tenant DB file).
const _dbByPath = new Map<string, StickerDatabase>();

/** Lazily open (and cache) the WAL-mode connection for this tenant's DB. */
function getStickerDb(folderPath: string | null | undefined): StickerDatabase {
  const dbPath = stickerDbPath(folderPath);
  const cached = _dbByPath.get(dbPath);
  if (cached) return cached;

  fs.ensureDirSync(path.dirname(dbPath));
  const db = new Database(dbPath, { timeout: 30000 });
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("busy_timeout = 30000");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS stickers (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id        TEXT    NOT NULL,
      name           TEXT    NOT NULL,
      file_path      TEXT    NOT NULL DEFAULT '',
      lottie_payload TEXT    DEFAULT NULL,
      added_by       TEXT    NOT NULL DEFAULT '',
      added_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(chat_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_stickers_chat
      ON stickers (chat_id, name);
  `);
  // Migration: add lottie_payload column for existing installs.
  try {
    db.exec(`ALTER TABLE stickers ADD COLUMN lottie_payload TEXT DEFAULT NULL`);
  } catch {
    /* column already exists */
  }
  _dbByPath.set(dbPath, db);
  return db;
}

// ---------------------------------------------------------------------------
// Scope parsing — accept the shared `global` | `default` vocabulary
// ---------------------------------------------------------------------------

export interface StickerScope {
  /** "chat" (per-chat) | "global" | "default". */
  scope: ConfigScope;
  /** true for both `global` and `default` (the shared `__global__` catalog). */
  isShared: boolean;
  /** `__global__` when shared, else the passed-in chatId. */
  targetChatId: string;
  /** Remaining sticker-name argument (raw — not yet lowercased/validated). */
  name: string;
  /** Confirmation/permission label, e.g. " global", " default", or "". */
  label: string;
}

/**
 * Parse an optional leading scope token from a sticker command's args.
 *
 * Unlike per-chat config rows, the sticker catalog has a single shared table
 * keyed by `chat_id`, where `__global__` is the cross-chat fallback (see
 * `get_sticker`/`list_stickers` in sticker_db.py). So BOTH `global` (legacy)
 * and `default` (the semantically-correct fallback keyword, and what the rest
 * of the config commands accept) map to that one `__global__` catalog.
 */
export function parseStickerScope(
  args: string | undefined,
  chatId: string,
): StickerScope {
  const rawArgs = (args || "").trim();
  const parts = rawArgs.split(/\s+/);
  const scope = parseConfigScope(parts[0]?.toLowerCase());
  const isShared = scope !== "chat";
  return {
    scope,
    isShared,
    targetChatId: isShared ? GLOBAL_STICKER_CHAT_ID : chatId,
    name: isShared ? parts.slice(1).join(" ").trim() : rawArgs,
    label: isShared ? ` ${scope}` : "",
  };
}

// ---------------------------------------------------------------------------
// CRUD — all keyed by the tenant's folderPath (resolves the correct DB file)
// ---------------------------------------------------------------------------

/** Register/replace a regular (WebP) sticker. Returns "added" | "updated". */
export function upsertWebpSticker(
  folderPath: string | null | undefined,
  chatId: string,
  name: string,
  filePath: string,
  addedBy: string,
): "added" | "updated" {
  const db = getStickerDb(folderPath);
  const existing = db
    .prepare("SELECT id FROM stickers WHERE chat_id = ? AND name = ?")
    .get(chatId, name);
  if (existing) {
    db.prepare(
      `UPDATE stickers
       SET file_path = ?, lottie_payload = NULL, added_by = ?, added_at = datetime('now')
       WHERE chat_id = ? AND name = ?`,
    ).run(filePath, addedBy, chatId, name);
    return "updated";
  }
  db.prepare(
    `INSERT INTO stickers (chat_id, name, file_path, lottie_payload, added_by)
     VALUES (?, ?, ?, NULL, ?)`,
  ).run(chatId, name, filePath, addedBy);
  return "added";
}

/** Register/replace a Lottie sticker by its JSON payload (no file). */
export function upsertLottieSticker(
  folderPath: string | null | undefined,
  chatId: string,
  name: string,
  lottiePayloadJson: string,
  addedBy: string,
): "added" | "updated" {
  const db = getStickerDb(folderPath);
  const existing = db
    .prepare("SELECT id FROM stickers WHERE chat_id = ? AND name = ?")
    .get(chatId, name);
  if (existing) {
    db.prepare(
      `UPDATE stickers
       SET file_path = '', lottie_payload = ?, added_by = ?, added_at = datetime('now')
       WHERE chat_id = ? AND name = ?`,
    ).run(lottiePayloadJson, addedBy, chatId, name);
    return "updated";
  }
  db.prepare(
    `INSERT INTO stickers (chat_id, name, file_path, lottie_payload, added_by)
     VALUES (?, ?, '', ?, ?)`,
  ).run(chatId, name, lottiePayloadJson, addedBy);
  return "added";
}

/** Delete a sticker row. Returns true if a row was deleted. */
export function deleteSticker(
  folderPath: string | null | undefined,
  chatId: string,
  name: string,
): boolean {
  const db = getStickerDb(folderPath);
  const result = db
    .prepare("DELETE FROM stickers WHERE chat_id = ? AND name = ?")
    .run(chatId, name);
  return result.changes > 0;
}
