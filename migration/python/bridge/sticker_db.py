"""Sticker database — user-managed sticker catalog stored in a separate SQLite DB.

Why a separate DB?
  Stickers uploaded via /addsticker are stored in ``stickers.db`` (not settings.db).
  This keeps the user-managed sticker catalog isolated from bot settings so that:
  - A corrupt or wiped settings.db never destroys the sticker catalog.
  - The sticker catalog can be backed up / migrated independently.

Schema
------
``stickers`` table:
  - chat_id       TEXT  — the group/private chat that owns this sticker (NULL = global)
  - name          TEXT  — sticker name (lowercased, trimmed), unique per chat_id
  - file_path     TEXT  — absolute path to the stored .webp file (empty string for Lottie-only entries)
  - lottie_payload TEXT — JSON string of the full lottieStickerMessage payload (NULL for regular stickers)
  - added_by      TEXT  — JID of the member who added it (for auditing)
  - added_at      TEXT  — ISO datetime

Lottie stickers
---------------
When a premium/Lottie sticker is added via /addsticker, instead of downloading
and saving a degraded .webp file, the full ``lottieStickerMessage`` JSON object
is stored in ``lottie_payload``. When the bot needs to send it, it relays the
original payload verbatim (using Baileys ``relayMessage``) so the animation is
fully preserved.

Usage
-----
``add_sticker(chat_id, name, source_path, added_by)``
``add_lottie_sticker(chat_id, name, lottie_payload_json, added_by)``
``get_sticker(chat_id, name)`` → dict {"file_path": ..., "lottie_payload": ...} or None
``list_stickers(chat_id)``     → list of names available in chat
``remove_sticker(chat_id, name)`` → bool
``get_db_path()``              → Path  (for admin tooling)
"""
from __future__ import annotations

import os
import shutil
import sqlite3
import threading
import time
from pathlib import Path
from typing import Optional

from .log import setup_logging

try:
  from .db import current_tenant_db_root as _current_tenant_db_root
except ImportError:
  from bridge.db import current_tenant_db_root as _current_tenant_db_root  # type: ignore

logger = setup_logging()

# ---------------------------------------------------------------------------
# Path resolution
# ---------------------------------------------------------------------------

_DEFAULT_DB_DIR = Path(__file__).resolve().parent.parent.parent / "data"
_DB_PATH: Optional[Path] = None

# Where uploaded sticker files are stored persistently
_DEFAULT_STICKER_UPLOAD_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "stickers_user"

_LOCAL = threading.local()

# ---------------------------------------------------------------------------
# DB busy / corruption helpers (mirrors db.py pattern)
# ---------------------------------------------------------------------------

_DB_CORRUPTION_TOKENS = (
  "malformed",
  "disk image is malformed",
  "not a database",
  "file is not a database",
  "database corruption",
)

_DB_BUSY_TOKENS = (
  "database is locked",
  "database table is locked",
  "database is busy",
)

DB_BUSY_TIMEOUT_SECONDS = float(os.getenv("DB_BUSY_TIMEOUT_SECONDS", "30"))
DB_OPERATION_RETRY_MAX = int(os.getenv("DB_OPERATION_RETRY_MAX", "8"))
DB_OPERATION_RETRY_BASE = float(os.getenv("DB_OPERATION_RETRY_BASE_SECONDS", "0.05"))


def _is_corruption_error(exc: BaseException) -> bool:
  if not isinstance(exc, sqlite3.DatabaseError):
    return False
  msg = str(exc).lower()
  return any(t in msg for t in _DB_CORRUPTION_TOKENS)


def _is_busy_error(exc: BaseException) -> bool:
  if not isinstance(exc, sqlite3.OperationalError):
    return False
  msg = str(exc).lower()
  return any(t in msg for t in _DB_BUSY_TOKENS)


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

def _resolve_db_path() -> Path:
  # Per-tenant routing (Step 33 / CONTRACT.md §8): when an AgentSession has
  # bound a tenant, resolve under ``<folder_path>/db/stickers.db`` so each
  # account owns its own sticker catalog with no cross-talk. Falls back to the
  # legacy global env path / DATA_DIR when no tenant is bound.
  root = _current_tenant_db_root()
  if root is not None:
    path = root / "stickers.db"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path
  global _DB_PATH
  if _DB_PATH is not None:
    return _DB_PATH
  raw = os.getenv("BOT_STICKERS_DB_PATH") or os.getenv("STICKERS_DB_PATH")
  if raw and raw.strip():
    _DB_PATH = Path(raw.strip())
  else:
    _DB_PATH = _DEFAULT_DB_DIR / "stickers.db"
  _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
  return _DB_PATH


def _sticker_upload_dir() -> Path:
  raw = os.getenv("STICKER_UPLOAD_DIR")
  if raw and raw.strip():
    d = Path(raw.strip())
  else:
    d = _DEFAULT_STICKER_UPLOAD_DIR
  d.mkdir(parents=True, exist_ok=True)
  return d


# ---------------------------------------------------------------------------
# Connection management (thread-local)
# ---------------------------------------------------------------------------

def _new_conn(db_path: Path) -> sqlite3.Connection:
  conn = sqlite3.connect(str(db_path), timeout=DB_BUSY_TIMEOUT_SECONDS)
  conn.execute("PRAGMA journal_mode=WAL")
  conn.execute("PRAGMA synchronous=FULL")
  conn.execute(f"PRAGMA busy_timeout={int(DB_BUSY_TIMEOUT_SECONDS * 1000)}")
  conn.execute("PRAGMA foreign_keys=ON")
  conn.row_factory = sqlite3.Row
  return conn


def _ensure_tables(conn: sqlite3.Connection) -> None:
  conn.executescript(
    """
    CREATE TABLE IF NOT EXISTS stickers (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id       TEXT    NOT NULL,
      name          TEXT    NOT NULL,
      file_path     TEXT    NOT NULL DEFAULT '',
      lottie_payload TEXT   DEFAULT NULL,
      added_by      TEXT    NOT NULL DEFAULT '',
      added_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(chat_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_stickers_chat
      ON stickers (chat_id, name);
    """
  )
  # Migration: add lottie_payload column to existing installs
  try:
    conn.execute("ALTER TABLE stickers ADD COLUMN lottie_payload TEXT DEFAULT NULL")
    conn.commit()
  except sqlite3.OperationalError:
    pass  # Column already exists
  conn.commit()


def _get_conn() -> sqlite3.Connection:
  db_path = _resolve_db_path()
  store = getattr(_LOCAL, "sticker_conns", None)
  if store is None:
    store = {}
    _LOCAL.sticker_conns = store
  key = str(db_path)
  conn: Optional[sqlite3.Connection] = store.get(key)
  if conn is not None:
    return conn
  conn = _new_conn(db_path)
  _ensure_tables(conn)
  store[key] = conn
  return conn


def _drop_conn() -> None:
  store = getattr(_LOCAL, "sticker_conns", None)
  if not store:
    return
  db_path = str(_resolve_db_path())
  conn: Optional[sqlite3.Connection] = store.get(db_path)
  if conn is not None:
    try:
      conn.close()
    except Exception:
      pass
    store.pop(db_path, None)


def _backup_corrupt(db_path: Path) -> None:
  if not db_path.exists():
    return
  backup = db_path.with_name(db_path.name + ".corrupted.bak")
  i = 1
  while backup.exists():
    backup = db_path.with_name(f"{db_path.name}.corrupted.{i}.bak")
    i += 1
  try:
    db_path.rename(backup)
    logger.warning("sticker_db: corrupt DB backed up to %s", backup.name)
  except OSError:
    try:
      db_path.unlink()
    except OSError:
      pass


def _recover() -> None:
  db_path = _resolve_db_path()
  for ext in ("-wal", "-shm", "-journal"):
    sidecar = db_path.with_name(db_path.name + ext)
    if sidecar.exists():
      sidecar.unlink(missing_ok=True)
  # Quick-check after sidecar removal
  try:
    test = sqlite3.connect(str(db_path), timeout=5)
    ok = test.execute("PRAGMA quick_check").fetchone()
    test.close()
    if ok and ok[0] == "ok":
      return
  except Exception:
    pass
  _backup_corrupt(db_path)


def _run(fn):
  """Run *fn* with busy-retry and single corruption-recovery."""
  attempt = 0
  corruption_retried = False
  while True:
    try:
      return fn()
    except sqlite3.DatabaseError as exc:
      if _is_corruption_error(exc) and not corruption_retried:
        corruption_retried = True
        logger.warning("sticker_db: corruption detected, recovering: %s", exc)
        _drop_conn()
        _recover()
        continue
      if _is_busy_error(exc) and attempt < DB_OPERATION_RETRY_MAX:
        time.sleep(DB_OPERATION_RETRY_BASE * (2 ** attempt))
        attempt += 1
        continue
      raise


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

GLOBAL_STICKER_CHAT_ID = "__global__"

# Name validation: lowercase alphanumeric, hyphens, underscores, 1-64 chars
import re as _re
_NAME_RE = _re.compile(r"^[a-z0-9_\-]{1,64}$")


def normalize_name(name: str) -> str:
  """Lowercase and strip a sticker name."""
  return name.strip().lower()


def is_valid_name(name: str) -> bool:
  """Return True if *name* is a valid sticker identifier."""
  return bool(_NAME_RE.match(normalize_name(name)))


def get_db_path() -> Path:
  """Return the resolved path to the sticker database file."""
  return _resolve_db_path()


def add_sticker(
  chat_id: str,
  name: str,
  source_path: str,
  added_by: str = "",
) -> tuple[bool, str]:
  """
  Copy *source_path* into the persistent upload directory and register it as
  a regular (non-Lottie) WebP sticker.

  Returns:
    (True, stored_path)  on success
    (False, error_msg)   on failure
  """
  normalized = normalize_name(name)
  if not is_valid_name(normalized):
    return False, (
      f"Nama sticker tidak valid: *{name}*\n"
      "Gunakan huruf kecil, angka, underscore, atau tanda minus (1-64 karakter)."
    )

  if not os.path.isfile(source_path):
    return False, f"File sticker tidak ditemukan: {source_path}"

  # Determine destination filename
  upload_dir = _sticker_upload_dir()
  import hashlib
  chat_hash = hashlib.md5(chat_id.encode()).hexdigest()[:8]
  dest_filename = f"{chat_hash}_{normalized}.webp"
  dest_path = upload_dir / dest_filename

  def _do():
    conn = _get_conn()
    existing = conn.execute(
      "SELECT file_path FROM stickers WHERE chat_id = ? AND name = ?",
      (chat_id, normalized),
    ).fetchone()

    shutil.copy2(source_path, str(dest_path))

    if existing:
      conn.execute(
        """UPDATE stickers
           SET file_path = ?, lottie_payload = NULL, added_by = ?, added_at = datetime('now')
           WHERE chat_id = ? AND name = ?""",
        (str(dest_path), added_by, chat_id, normalized),
      )
    else:
      conn.execute(
        "INSERT INTO stickers (chat_id, name, file_path, lottie_payload, added_by) VALUES (?, ?, ?, NULL, ?)",
        (chat_id, normalized, str(dest_path), added_by),
      )
    conn.commit()
    return str(dest_path)

  try:
    stored = _run(_do)
    logger.info(
      "sticker_db: add (webp) chat_id=%s name=%s added_by=%s path=%s",
      chat_id, normalized, added_by, stored,
    )
    return True, stored
  except Exception as exc:
    logger.exception("sticker_db: add failed chat_id=%s name=%s: %s", chat_id, normalized, exc)
    return False, f"Gagal menyimpan sticker: {exc}"


def add_lottie_sticker(
  chat_id: str,
  name: str,
  lottie_payload_json: str,
  added_by: str = "",
) -> tuple[bool, str]:
  """
  Register a Lottie/premium sticker by storing its full message JSON payload.

  Unlike ``add_sticker``, no file is downloaded — the original
  ``lottieStickerMessage`` JSON is stored verbatim so the bot can relay it
  later using Baileys ``relayMessage``, preserving the Lottie animation.

  Args:
    chat_id:             The chat that owns this sticker.
    name:                The sticker name (will be normalized).
    lottie_payload_json: JSON string of the full lottieStickerMessage object.
    added_by:            JID of the member who added it.

  Returns:
    (True, "lottie")   on success
    (False, error_msg) on failure
  """
  normalized = normalize_name(name)
  if not is_valid_name(normalized):
    return False, (
      f"Nama sticker tidak valid: *{name}*\n"
      "Gunakan huruf kecil, angka, underscore, atau tanda minus (1-64 karakter)."
    )

  if not lottie_payload_json or not lottie_payload_json.strip():
    return False, "Lottie payload kosong."

  def _do():
    conn = _get_conn()
    existing = conn.execute(
      "SELECT id FROM stickers WHERE chat_id = ? AND name = ?",
      (chat_id, normalized),
    ).fetchone()

    if existing:
      conn.execute(
        """UPDATE stickers
           SET file_path = '', lottie_payload = ?, added_by = ?, added_at = datetime('now')
           WHERE chat_id = ? AND name = ?""",
        (lottie_payload_json, added_by, chat_id, normalized),
      )
    else:
      conn.execute(
        "INSERT INTO stickers (chat_id, name, file_path, lottie_payload, added_by) VALUES (?, ?, '', ?, ?)",
        (chat_id, normalized, lottie_payload_json, added_by),
      )
    conn.commit()

  try:
    _run(_do)
    logger.info(
      "sticker_db: add (lottie) chat_id=%s name=%s added_by=%s",
      chat_id, normalized, added_by,
    )
    return True, "lottie"
  except Exception as exc:
    logger.exception("sticker_db: add_lottie failed chat_id=%s name=%s: %s", chat_id, normalized, exc)
    return False, f"Gagal menyimpan sticker Lottie: {exc}"


def get_sticker(chat_id: str, name: str) -> Optional[dict]:
  """
  Resolve sticker by name for a given chat.

  Lookup order:
    1. Chat-specific sticker
    2. Global sticker (chat_id == GLOBAL_STICKER_CHAT_ID)

  Returns a dict:
    {
      "file_path":      str | None,   # path to .webp file, or None for Lottie
      "lottie_payload": str | None,   # JSON string for Lottie stickers, or None
    }
  Or None if the sticker is not found.

  Callers should check ``lottie_payload`` first: if set, use relayMessage.
  Otherwise use ``file_path`` for normal WebP send.
  """
  normalized = normalize_name(name)

  def _do():
    conn = _get_conn()
    # Chat-specific first
    row = conn.execute(
      "SELECT file_path, lottie_payload FROM stickers WHERE chat_id = ? AND name = ?",
      (chat_id, normalized),
    ).fetchone()
    if row:
      return {"file_path": row["file_path"] or None, "lottie_payload": row["lottie_payload"]}
    # Global fallback
    row = conn.execute(
      "SELECT file_path, lottie_payload FROM stickers WHERE chat_id = ? AND name = ?",
      (GLOBAL_STICKER_CHAT_ID, normalized),
    ).fetchone()
    if row:
      return {"file_path": row["file_path"] or None, "lottie_payload": row["lottie_payload"]}
    return None

  try:
    return _run(_do)
  except Exception as exc:
    logger.error("sticker_db: get failed chat_id=%s name=%s: %s", chat_id, normalized, exc)
    return None


def list_stickers(chat_id: str) -> list[str]:
  """
  Return sorted list of sticker names available for a chat.

  Includes both chat-specific and global stickers (deduped, chat-specific wins).
  """
  def _do():
    conn = _get_conn()
    rows = conn.execute(
      """
      SELECT name FROM stickers
      WHERE chat_id = ? OR chat_id = ?
      GROUP BY name
      ORDER BY name ASC
      """,
      (chat_id, GLOBAL_STICKER_CHAT_ID),
    ).fetchall()
    return [r["name"] for r in rows]

  try:
    return _run(_do)
  except Exception as exc:
    logger.error("sticker_db: list failed chat_id=%s: %s", chat_id, exc)
    return []


def remove_sticker(chat_id: str, name: str) -> tuple[bool, str]:
  """
  Remove a sticker entry for *chat_id*.

  Does NOT delete the physical file (orphan GC can be done separately).

  Returns:
    (True, "")        on success
    (False, reason)   if not found or error
  """
  normalized = normalize_name(name)

  def _do():
    conn = _get_conn()
    cur = conn.execute(
      "DELETE FROM stickers WHERE chat_id = ? AND name = ?",
      (chat_id, normalized),
    )
    conn.commit()
    return cur.rowcount > 0

  try:
    found = _run(_do)
    if found:
      logger.info("sticker_db: remove chat_id=%s name=%s", chat_id, normalized)
      return True, ""
    return False, f"Sticker *{name}* tidak ditemukan untuk chat ini."
  except Exception as exc:
    logger.exception("sticker_db: remove failed chat_id=%s name=%s: %s", chat_id, normalized, exc)
    return False, f"Gagal menghapus sticker: {exc}"


def close_connection() -> None:
  """Close the thread-local DB connection (call on shutdown)."""
  _drop_conn()
