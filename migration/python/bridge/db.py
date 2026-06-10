"""SQLite storage split by concern.

Hard cutover layout (default under DATA_DIR):
- settings.db   : chat_settings, llm_models
- stats.db      : chat_stats, chat_user_stats
- moderation.db : chat_mutes

Resilience: every public CRUD helper is wrapped with ``@_db_resilient`` which
catches ``sqlite3.DatabaseError`` (e.g. ``database disk image is malformed``,
``not a database``), drops the cached thread-local connection, runs
``_recover_corrupt_db`` (delete stale WAL/SHM, then back up + recreate the main
file as a last resort), and retries the operation once. Without this wrapper
a single corruption — usually triggered by an unclean shutdown that leaves a
half-written WAL — would permanently break every subsequent read on the
affected DB until the process restarted.
"""
from __future__ import annotations

import functools
import os
import sqlite3
import threading
import time
import contextlib
import contextvars
from pathlib import Path
from typing import Callable, Optional, TypeVar

from .log import setup_logging

logger = setup_logging()

_DEFAULT_DB_DIR = Path(__file__).resolve().parent.parent.parent / 'data'
_SETTINGS_DB_PATH: Path | None = None
_STATS_DB_PATH: Path | None = None
_MODERATION_DB_PATH: Path | None = None
_LOCAL = threading.local()

# ---------------------------------------------------------------------------
# Per-tenant DB routing (Step 33 / CONTRACT.md §8)
# ---------------------------------------------------------------------------
# Multi-account boot drives N AgentSessions in one asyncio thread. Each session
# must read/write its OWN ``<folder_path>/db/*.db`` files with no cross-talk.
# Because every session shares the single event-loop thread, a plain
# ``threading.local`` connection slot would be shared across tenants — so we
# (a) resolve DB paths through a ``ContextVar`` the session sets for the
# duration of its work, and (b) key cached connections by their resolved path
# (not just the db_kind) so two tenants get two independent SQLite handles.
#
# When the ContextVar is UNSET (default ``None``) the resolver falls back to
# the legacy global env paths (``SETTINGS_DB_PATH`` etc.) / ``DATA_DIR`` so the
# single-account behaviour and all existing unit tests keep working unchanged.
_tenant_db_dir: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
  'bridge_tenant_db_dir', default=None
)


def set_tenant_db_dir(folder_path: Optional[str]) -> contextvars.Token:
  """Bind the current (async) context to ``<folder_path>/db/`` for all DB
  access until :func:`reset_tenant_db_dir` is called with the returned token.
  Pass ``None`` to explicitly select the legacy global paths."""
  return _tenant_db_dir.set(folder_path)


def reset_tenant_db_dir(token: contextvars.Token) -> None:
  """Undo a previous :func:`set_tenant_db_dir` using its token."""
  _tenant_db_dir.reset(token)


@contextlib.contextmanager
def tenant_db_context(folder_path: Optional[str]):
  """Context manager form of :func:`set_tenant_db_dir`."""
  token = _tenant_db_dir.set(folder_path)
  try:
    yield
  finally:
    _tenant_db_dir.reset(token)


def current_tenant_db_root() -> Optional[Path]:
  """Return the active tenant's ``<folder_path>/db`` directory, or ``None`` when
  no tenant is bound (legacy single-account / global path mode). Shared with
  ``sticker_db`` so the sticker catalog DB resolves under the same per-tenant
  directory."""
  fp = _tenant_db_dir.get()
  if fp:
    return Path(fp) / 'db'
  return None

# ---------------------------------------------------------------------------
# In-memory cache  (chat_id → value)
# ---------------------------------------------------------------------------
_prompt_cache: dict[str, Optional[str]] = {}
_permission_cache: dict[str, int] = {}
_mode_cache: dict[str, str] = {}
_triggers_cache: dict[str, str] = {}
_subagent_enabled_cache: dict[str, bool] = {}
# Mute cache: {chat_id: {sender_ref: {"muted_at": str, "duration_m": int, "notified": bool}}}
_mute_cache: dict[str, dict[str, dict]] = {}
_cache_lock = threading.Lock()

VALID_MODES = {'auto', 'prefix', 'hybrid'}
DEFAULT_MODE = 'prefix'
VALID_TRIGGERS = {'tag', 'reply', 'join', 'name'}
DEFAULT_TRIGGERS = 'tag,reply,name'
DEFAULT_SUBAGENT_ENABLED = False
GLOBAL_CHAT_ID = '__global__'
PROMPT_OVERRIDE_PATH = Path(__file__).resolve().parent.parent / "promptoverride.txt"
_DEFAULT_PROMPT_OVERRIDE: str | None = None


def _load_default_prompt_override() -> str | None:
  """Load the default prompt override from promptoverride.txt, or None if empty/missing."""
  try:
    lines = PROMPT_OVERRIDE_PATH.read_text(encoding="utf-8").splitlines()
    # Strip leading/trailing whitespace per line, filter out empty and comment-only lines
    cleaned = '\n'.join(
      line for line in (l.strip() for l in lines)
      if line and not line.startswith('//')
    ).strip()
    return cleaned if cleaned else None
  except (FileNotFoundError, IOError, OSError):
    return None


_DEFAULT_PROMPT_OVERRIDE = _load_default_prompt_override()


def _env_float(name: str, default: float, minimum: float) -> float:
  raw = os.getenv(name)
  if raw is None or not raw.strip():
    return max(minimum, default)
  try:
    return max(minimum, float(raw))
  except (TypeError, ValueError):
    return max(minimum, default)


def _env_int(name: str, default: int, minimum: int) -> int:
  raw = os.getenv(name)
  if raw is None or not raw.strip():
    return max(minimum, default)
  try:
    return max(minimum, int(float(raw)))
  except (TypeError, ValueError):
    return max(minimum, default)


DB_BUSY_TIMEOUT_SECONDS = _env_float('DB_BUSY_TIMEOUT_SECONDS', 30.0, 1.0)
DB_BUSY_TIMEOUT_MS = int(DB_BUSY_TIMEOUT_SECONDS * 1000)
DB_OPERATION_RETRY_MAX = _env_int('DB_OPERATION_RETRY_MAX', 8, 1)
DB_OPERATION_RETRY_BASE_SECONDS = _env_float('DB_OPERATION_RETRY_BASE_SECONDS', 0.05, 0.001)
DB_RECOVERY_LOCK_STALE_SECONDS = _env_float('DB_RECOVERY_LOCK_STALE_SECONDS', 120.0, 1.0)
# Deadline waiting *for* the lock is independent of the staleness window, so a
# legitimately slow recovery isn't both still-running and considered stale at
# the same moment.
DB_RECOVERY_LOCK_WAIT_SECONDS = _env_float(
  'DB_RECOVERY_LOCK_WAIT_SECONDS', DB_RECOVERY_LOCK_STALE_SECONDS * 2, 1.0,
)

# Sentinel to distinguish "we looked it up and it was NULL/missing" from
# "we haven't looked it up yet".
_MISSING = object()


def _data_dir() -> Path:
  return Path(os.getenv('DATA_DIR', str(_DEFAULT_DB_DIR)))


def _env_path(*keys: str) -> str | None:
  for key in keys:
    raw = os.getenv(key)
    if raw and raw.strip():
      return raw.strip()
  return None


def _resolve_settings_db_path() -> Path:
  root = current_tenant_db_root()
  if root is not None:
    path = root / 'settings.db'
    path.parent.mkdir(parents=True, exist_ok=True)
    return path
  global _SETTINGS_DB_PATH
  if _SETTINGS_DB_PATH is not None:
    return _SETTINGS_DB_PATH
  raw = _env_path('BOT_SETTINGS_DB_PATH', 'SETTINGS_DB_PATH')
  if raw:
    _SETTINGS_DB_PATH = Path(raw)
  else:
    _SETTINGS_DB_PATH = _data_dir() / 'settings.db'
  _SETTINGS_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
  return _SETTINGS_DB_PATH


def _resolve_stats_db_path() -> Path:
  root = current_tenant_db_root()
  if root is not None:
    path = root / 'stats.db'
    path.parent.mkdir(parents=True, exist_ok=True)
    return path
  global _STATS_DB_PATH
  if _STATS_DB_PATH is not None:
    return _STATS_DB_PATH
  raw = _env_path('BOT_STATS_DB_PATH', 'STATS_DB_PATH')
  if raw:
    _STATS_DB_PATH = Path(raw)
  else:
    _STATS_DB_PATH = _data_dir() / 'stats.db'
  _STATS_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
  return _STATS_DB_PATH


def _resolve_moderation_db_path() -> Path:
  root = current_tenant_db_root()
  if root is not None:
    path = root / 'moderation.db'
    path.parent.mkdir(parents=True, exist_ok=True)
    return path
  global _MODERATION_DB_PATH
  if _MODERATION_DB_PATH is not None:
    return _MODERATION_DB_PATH
  raw = _env_path('BOT_MODERATION_DB_PATH', 'MODERATION_DB_PATH')
  if raw:
    _MODERATION_DB_PATH = Path(raw)
  else:
    _MODERATION_DB_PATH = _data_dir() / 'moderation.db'
  _MODERATION_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
  return _MODERATION_DB_PATH


def _backup_corrupt_file(db_path: Path) -> Optional[Path]:
  """Move a corrupt DB file aside as ``<name>.corrupted[.N].bak``."""
  if not db_path.exists():
    return None
  backup = db_path.with_name(db_path.name + '.corrupted.bak')
  if backup.exists():
    i = 1
    while db_path.with_name(f'{db_path.name}.corrupted.{i}.bak').exists():
      i += 1
    backup = db_path.with_name(f'{db_path.name}.corrupted.{i}.bak')
  try:
    db_path.rename(backup)
    logger.warning('DB recovery: corrupt %s renamed to %s', db_path.name, backup.name)
    return backup
  except OSError as exc:
    logger.error('DB recovery: could not rename %s: %s', db_path, exc)
    try:
      db_path.unlink()
      logger.warning('DB recovery: deleted corrupt %s', db_path.name)
    except OSError:
      pass
    return None


def _probe_db(db_path: Path) -> bool:
  """Open *db_path* read-only and check ``PRAGMA integrity_check``.

  Returns ``True`` iff SQLite reports the file as ``ok``. Any error or any
  non-``ok`` result is treated as corruption.
  """
  if not db_path.exists():
    return True
  try:
    test_conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True, timeout=DB_BUSY_TIMEOUT_SECONDS)
    try:
      rows = test_conn.execute('PRAGMA integrity_check').fetchall()
    finally:
      test_conn.close()
    return bool(rows) and all(
      (row[0] if not isinstance(row, sqlite3.Row) else row[0]) == 'ok'
      for row in rows
    )
  except sqlite3.DatabaseError:
    return False


class _RecoveryLock:
  def __init__(self, db_path: Path):
    self.lock_path = db_path.with_name(db_path.name + '.recover.lock')
    self.fd: int | None = None

  def __enter__(self):  # type: ignore[no-untyped-def]
    deadline = time.monotonic() + DB_RECOVERY_LOCK_WAIT_SECONDS
    while self.fd is None:
      try:
        self.fd = os.open(str(self.lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        try:
          os.write(self.fd, f'{os.getpid()}\n{time.time()}\n'.encode())
        except OSError:
          # Don't leak the fd or the lock file if the write itself fails
          # (e.g. ENOSPC). __exit__ is not called when __enter__ raises, so
          # clean up explicitly.
          try:
            os.close(self.fd)
          except OSError:
            pass
          self.fd = None
          try:
            self.lock_path.unlink()
          except FileNotFoundError:
            pass
          raise
      except FileExistsError:
        try:
          age = time.time() - self.lock_path.stat().st_mtime
          if age > DB_RECOVERY_LOCK_STALE_SECONDS:
            self.lock_path.unlink()
            continue
        except FileNotFoundError:
          continue
        if time.monotonic() >= deadline:
          raise TimeoutError(f'timed out waiting for DB recovery lock: {self.lock_path}')
        time.sleep(0.05)
    return self

  def heartbeat(self) -> None:
    """Refresh the lock's mtime so peers don't consider it stale."""
    try:
      os.utime(self.lock_path, None)
    except FileNotFoundError:
      pass

  def __exit__(self, exc_type, exc, tb):  # type: ignore[no-untyped-def]
    if self.fd is not None:
      os.close(self.fd)
      self.fd = None
    try:
      self.lock_path.unlink()
    except FileNotFoundError:
      pass


def _recover_corrupt_db(db_path: Path) -> None:
  """Attempt to recover a corrupt SQLite database without deleting evidence."""
  with _RecoveryLock(db_path) as lock:
    if _probe_db(db_path):
      return
    lock.heartbeat()

    for ext in ('-wal', '-shm', '-journal'):
      p = db_path.with_name(db_path.name + ext)
      if p.exists():
        _backup_corrupt_file(p)
    lock.heartbeat()

    if _probe_db(db_path):
      logger.info('DB recovery: %s recovered after sidecar quarantine', db_path.name)
      return

    logger.warning('DB recovery: %s still corrupt after sidecar quarantine, recreating', db_path.name)
    _backup_corrupt_file(db_path)


def _new_conn(db_path: Path) -> sqlite3.Connection:
  """Open a SQLite connection with WAL mode and resilient PRAGMAs."""
  def _configure(conn: sqlite3.Connection) -> None:
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA synchronous=FULL')
    conn.execute(f'PRAGMA busy_timeout={DB_BUSY_TIMEOUT_MS}')
    conn.execute('PRAGMA wal_autocheckpoint=1000')
    conn.execute('PRAGMA journal_size_limit=67108864')
    conn.execute('PRAGMA temp_store=MEMORY')
    conn.execute('PRAGMA foreign_keys=ON')
    conn.execute('PRAGMA cache_size=-4000')
    row = conn.execute('PRAGMA quick_check').fetchone()
    if row is None or row[0] != 'ok':
      raise sqlite3.DatabaseError(f'database disk image is malformed (quick_check: {row[0] if row else "empty"})')

  conn: sqlite3.Connection | None = None
  try:
    conn = sqlite3.connect(str(db_path), timeout=DB_BUSY_TIMEOUT_SECONDS)
    _configure(conn)
    conn.row_factory = sqlite3.Row
    return conn
  except sqlite3.DatabaseError as exc:
    if not _is_db_corruption_error(exc):
      raise
    logger.warning('DB: %s appears corrupt on open (%s); attempting recovery', db_path.name, exc)
    if conn is not None:
      try:
        conn.close()
      except Exception:
        pass
    _recover_corrupt_db(db_path)
    conn = sqlite3.connect(str(db_path), timeout=DB_BUSY_TIMEOUT_SECONDS)
    _configure(conn)
    conn.row_factory = sqlite3.Row
    return conn


# ---------------------------------------------------------------------------
# Resilience: auto-recover on runtime corruption
# ---------------------------------------------------------------------------

# Substrings of sqlite3.DatabaseError messages that signal the on-disk file
# is unusable — i.e. dropping the cached connection and recovering may help.
_DB_CORRUPTION_TOKENS: tuple[str, ...] = (
  'malformed',
  'disk image is malformed',
  'not a database',
  'file is not a database',
  'file is encrypted',
  'database corruption',
)

_DB_BUSY_TOKENS: tuple[str, ...] = (
  'database is locked',
  'database table is locked',
  'database is busy',
  'database schema is locked',
)

_F = TypeVar('_F', bound=Callable[..., object])


def _is_db_corruption_error(exc: BaseException) -> bool:
  if not isinstance(exc, sqlite3.DatabaseError):
    return False
  msg = str(exc).lower()
  return any(token in msg for token in _DB_CORRUPTION_TOKENS)


def _is_db_busy_error(exc: BaseException) -> bool:
  if not isinstance(exc, sqlite3.OperationalError):
    return False
  msg = str(exc).lower()
  return any(token in msg for token in _DB_BUSY_TOKENS)


def _conn_store() -> dict:
  """Per-thread map of ``(db_kind, str(path)) -> sqlite3.Connection``.

  Keying by the resolved *path* (not just ``db_kind``) is what gives each
  tenant its own connection set even though all AgentSessions share the single
  asyncio thread (Step 33 / CONTRACT.md §8). Without the path in the key two
  tenants would alias the same handle and cross-write each other's DBs.
  """
  store = getattr(_LOCAL, 'conn_store', None)
  if store is None:
    store = {}
    _LOCAL.conn_store = store
  return store


def _cached_connection(db_kind: str) -> sqlite3.Connection | None:
  path = _resolve_path_for(db_kind)
  return _conn_store().get((db_kind, str(path)))


def _clear_cached_connection(db_kind: str) -> None:
  if db_kind not in ('settings', 'stats', 'moderation'):
    raise ValueError(f'unknown db_kind: {db_kind}')
  path = _resolve_path_for(db_kind)
  _conn_store().pop((db_kind, str(path)), None)


def _resolve_path_for(db_kind: str) -> Path:
  if db_kind == 'settings':
    return _resolve_settings_db_path()
  if db_kind == 'stats':
    return _resolve_stats_db_path()
  if db_kind == 'moderation':
    return _resolve_moderation_db_path()
  raise ValueError(f'unknown db_kind: {db_kind}')


def _drop_cached_connection(db_kind: str) -> None:
  """Close + forget the thread-local connection for *db_kind*."""
  conn = _cached_connection(db_kind)
  if conn is None:
    return
  try:
    conn.close()
  except Exception:
    pass
  _clear_cached_connection(db_kind)


def _rollback_cached_connection(db_kind: str) -> None:
  conn = _cached_connection(db_kind)
  if conn is not None:
    try:
      conn.rollback()
    except sqlite3.DatabaseError:
      _drop_cached_connection(db_kind)


def _clear_caches_for(db_kind: str) -> None:
  """Drop in-memory caches that were populated from *db_kind*.

  After recovery the on-disk DB may be empty (recreated), so cached values are
  no longer authoritative.
  """
  global _default_llm2_model_cache
  with _cache_lock:
    if db_kind == 'settings':
      _prompt_cache.clear()
      _permission_cache.clear()
      _mode_cache.clear()
      _triggers_cache.clear()
      _subagent_enabled_cache.clear()
      _llm2_model_cache.clear()
      _default_llm2_model_cache = None
    elif db_kind == 'moderation':
      _mute_cache.clear()


def _db_resilient(db_kind: str) -> Callable[[_F], _F]:
  """Decorator: retry busy writes and recover once after corruption."""
  def decorator(fn: _F) -> _F:
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):  # type: ignore[no-untyped-def]
      attempt = 0
      corruption_retries = 0
      while True:
        try:
          return fn(*args, **kwargs)
        except sqlite3.DatabaseError as exc:
          if _is_db_corruption_error(exc):
            if corruption_retries >= 1:
              raise
            corruption_retries += 1
            logger.warning(
              'DB %s: corruption detected in %s (%s); dropping connection and recovering',
              db_kind, fn.__name__, exc,
            )
            _drop_cached_connection(db_kind)
            try:
              _recover_corrupt_db(_resolve_path_for(db_kind))
            except Exception as recover_err:
              logger.error('DB %s: recovery failed: %s', db_kind, recover_err)
              raise exc from recover_err
            _clear_caches_for(db_kind)
            # Reset the busy-retry counter after a fresh recovery so the
            # post-recovery call gets a full backoff budget.
            attempt = 0
            continue
          if not _is_db_busy_error(exc) or attempt >= DB_OPERATION_RETRY_MAX:
            raise
          _rollback_cached_connection(db_kind)
          time.sleep(DB_OPERATION_RETRY_BASE_SECONDS * 2 ** attempt)
          attempt += 1
    return wrapper  # type: ignore[return-value]
  return decorator


def _ensure_settings_tables(conn: sqlite3.Connection) -> None:
  conn.executescript(
    f"""
    CREATE TABLE IF NOT EXISTS chat_settings (
      chat_id    TEXT PRIMARY KEY,
      prompt     TEXT,
      permission INTEGER NOT NULL DEFAULT 0,
      mode       TEXT NOT NULL DEFAULT '{DEFAULT_MODE}',
      triggers   TEXT NOT NULL DEFAULT '{DEFAULT_TRIGGERS}',
      llm2_model TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS llm_models (
      model_id       TEXT PRIMARY KEY,
      display_name   TEXT NOT NULL,
      description    TEXT,
      is_active      INTEGER NOT NULL DEFAULT 1,
      sort_order     INTEGER NOT NULL DEFAULT 0,
      vision_support INTEGER NOT NULL DEFAULT 0
    );
    """
  )
  for col, col_type, default in [
    ('mode', 'TEXT', f"'{DEFAULT_MODE}'"),
    ('triggers', 'TEXT', f"'{DEFAULT_TRIGGERS}'"),
    ('llm2_model', 'TEXT', 'NULL'),
    ('subagent_enabled', 'INTEGER', '0'),
    ('idle_trigger_min', 'INTEGER', 'NULL'),
    ('idle_trigger_max', 'INTEGER', 'NULL'),
  ]:
    try:
      conn.execute(f'ALTER TABLE chat_settings ADD COLUMN {col} {col_type} DEFAULT {default}')
      conn.commit()
    except sqlite3.OperationalError:
      pass

  # Migration: add vision_support column to llm_models if it doesn't exist
  try:
    conn.execute('ALTER TABLE llm_models ADD COLUMN vision_support INTEGER NOT NULL DEFAULT 0')
    conn.commit()
  except sqlite3.OperationalError:
    pass

  # Check whether the __global__ row already exists before we try to create it.
  # This tells us whether we should seed the default prompt override.
  global_exists = conn.execute(
    'SELECT 1 FROM chat_settings WHERE chat_id = ?', (GLOBAL_CHAT_ID,)
  ).fetchone() is not None

  # Ensure a __global__ defaults row exists so setGlobal* updates propagate
  # and get_* functions can fall back to it for chats without a specific row.
  conn.execute(
    'INSERT OR IGNORE INTO chat_settings (chat_id) VALUES (?)',
    (GLOBAL_CHAT_ID,),
  )
  conn.commit()

  # Only seed the default prompt override when creating the __global__ row for
  # the first time.  This prevents overwriting a user-cleared prompt on every
  # connection reset (e.g. after reset_settings_connection() or a new thread).
  if not global_exists and _DEFAULT_PROMPT_OVERRIDE:
    conn.execute(
      'UPDATE chat_settings SET prompt = ? WHERE chat_id = ?',
      (_DEFAULT_PROMPT_OVERRIDE, GLOBAL_CHAT_ID),
    )
    conn.commit()

  conn.executescript(
    """
    CREATE TABLE IF NOT EXISTS activation_codes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      code        TEXT UNIQUE NOT NULL,
      type        TEXT NOT NULL,
      days        INTEGER NOT NULL DEFAULT 0,
      used        INTEGER NOT NULL DEFAULT 0,
      used_by     TEXT DEFAULT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      created_by  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_activations (
      chat_id         TEXT PRIMARY KEY,
      code            TEXT NOT NULL,
      activated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at      TEXT DEFAULT NULL,
      expiry_notified INTEGER NOT NULL DEFAULT 0
    );
    """
  )


def _ensure_stats_tables(conn: sqlite3.Connection) -> None:
  conn.executescript(
    """
    CREATE TABLE IF NOT EXISTS chat_stats (
      chat_id      TEXT NOT NULL,
      period_type  TEXT NOT NULL,
      period_key   TEXT NOT NULL,
      stat_key     TEXT NOT NULL,
      stat_value   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chat_id, period_type, period_key, stat_key)
    );

    CREATE TABLE IF NOT EXISTS chat_user_stats (
      chat_id      TEXT NOT NULL,
      period_type  TEXT NOT NULL,
      period_key   TEXT NOT NULL,
      sender_ref   TEXT NOT NULL,
      sender_name  TEXT NOT NULL DEFAULT '',
      invoke_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chat_id, period_type, period_key, sender_ref)
    );
    """
  )


def _ensure_moderation_tables(conn: sqlite3.Connection) -> None:
  conn.executescript(
    """
    CREATE TABLE IF NOT EXISTS chat_mutes (
      chat_id    TEXT NOT NULL,
      sender_ref TEXT NOT NULL,
      muted_at   TEXT NOT NULL DEFAULT (datetime('now')),
      duration_m INTEGER NOT NULL DEFAULT 60,
      PRIMARY KEY (chat_id, sender_ref)
    );
    """
  )


def _ensure_split_ready() -> None:
  # Ensure connections are ready (creates tables if needed)
  _get_settings_conn()
  _get_stats_conn()
  _get_moderation_conn()


def _get_settings_conn() -> sqlite3.Connection:
  path = _resolve_settings_db_path()
  store = _conn_store()
  key = ('settings', str(path))
  conn = store.get(key)
  if conn is not None:
    return conn
  conn = _new_conn(path)
  _ensure_settings_tables(conn)
  store[key] = conn
  return conn


def _get_stats_conn() -> sqlite3.Connection:
  path = _resolve_stats_db_path()
  store = _conn_store()
  key = ('stats', str(path))
  conn = store.get(key)
  if conn is not None:
    return conn
  conn = _new_conn(path)
  _ensure_stats_tables(conn)
  store[key] = conn
  return conn


def _get_moderation_conn() -> sqlite3.Connection:
  path = _resolve_moderation_db_path()
  store = _conn_store()
  key = ('moderation', str(path))
  conn = store.get(key)
  if conn is not None:
    return conn
  conn = _new_conn(path)
  _ensure_moderation_tables(conn)
  store[key] = conn
  return conn


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def _pop_all_chat_caches(chat_id: str) -> None:
  """Drop every per-chat cache entry for *chat_id*.

  Called by setters that use INSERT...ON CONFLICT so that if the INSERT path
  creates a new row (with column defaults), other getters' caches (which may
  hold values from the __global__ fallback) are invalidated.
  """
  with _cache_lock:
    _prompt_cache.pop(chat_id, None)
    _permission_cache.pop(chat_id, None)
    _mode_cache.pop(chat_id, None)
    _triggers_cache.pop(chat_id, None)
    _llm2_model_cache.pop(chat_id, None)
    _subagent_enabled_cache.pop(chat_id, None)


def _ensure_chat_row(chat_id: str) -> None:
  """Ensure a per-chat row exists, copying all values from __global__ if needed.

  This prevents INSERT...ON CONFLICT from creating rows with SQL column defaults
  that shadow the __global__ fallback row with wrong values.
  Uses INSERT OR IGNORE to avoid UNIQUE constraint violations when concurrent
  workers (Node + Python) both observe the row is missing and try to insert.
  """
  if chat_id == GLOBAL_CHAT_ID:
    return
  conn = _get_settings_conn()
  conn.execute(
    """
    INSERT OR IGNORE INTO chat_settings
      (chat_id, prompt, permission, mode, triggers, llm2_model,
       subagent_enabled, idle_trigger_min, idle_trigger_max, updated_at)
    SELECT ?, prompt, permission, mode, triggers, llm2_model,
           subagent_enabled, idle_trigger_min, idle_trigger_max, datetime('now')
    FROM chat_settings WHERE chat_id = ?
    """,
    (chat_id, GLOBAL_CHAT_ID),
  )


def _get_setting_row(chat_id: str) -> Optional[sqlite3.Row]:
  """Return the chat_settings row for *chat_id*, falling back to __global__."""
  _ensure_split_ready()
  conn = _get_settings_conn()
  row = conn.execute(
    'SELECT * FROM chat_settings WHERE chat_id = ?', (chat_id,)
  ).fetchone()
  if row is not None:
    return row
  return conn.execute(
    'SELECT * FROM chat_settings WHERE chat_id = ?', (GLOBAL_CHAT_ID,)
  ).fetchone()


def _get_global_setting_row() -> Optional[sqlite3.Row]:
  """Return the __global__ settings row directly."""
  _ensure_split_ready()
  conn = _get_settings_conn()
  return conn.execute(
    'SELECT * FROM chat_settings WHERE chat_id = ?', (GLOBAL_CHAT_ID,)
  ).fetchone()


@_db_resilient('settings')
def get_prompt(chat_id: str, *, fallback_to_global: bool = True) -> Optional[str]:
  """Return the prompt for *chat_id*.

  When *fallback_to_global* is True (the default), returns the per-chat prompt
  if set, otherwise falls back to the global prompt override.  When False,
  returns only the per-chat prompt without falling back — useful for the
  ``/prompt`` command which needs to distinguish *"no custom prompt"* from
  *"uses the global default"*.

  The per-chat value is cached and shared regardless of *fallback_to_global*;
  the fallback is resolved at read time (never cached under a per-chat key)
  so that a global-prompt update immediately propagates to non-explicit chats.
  """
  with _cache_lock:
    cached = _prompt_cache.get(chat_id, _MISSING)
  if cached is not _MISSING:
    raw = cached  # type: ignore[assignment]
  else:
    # Query the per-chat row directly (not via _get_setting_row which falls
    # back to the __global__ row at the row level).  This ensures the cached
    # value is the per-chat prompt only, so the fallback logic below can be
    # applied freshly on every read.
    _ensure_split_ready()
    conn = _get_settings_conn()
    row = conn.execute(
      'SELECT prompt FROM chat_settings WHERE chat_id = ?', (chat_id,)
    ).fetchone()
    raw = row['prompt'] if row is not None else None
    with _cache_lock:
      _prompt_cache[chat_id] = raw

  # Apply fallback on top of the cached raw value
  if raw is None and fallback_to_global:
    global_prompt = _get_global_prompt_cached()
    if global_prompt is not None:
      return global_prompt
    # Last resort: the default prompt override from promptoverride.txt
    if _DEFAULT_PROMPT_OVERRIDE is not None:
      return _DEFAULT_PROMPT_OVERRIDE
  return raw


def _get_global_prompt_cached() -> Optional[str]:
  """Return the global prompt value, using the per-chat cache when available.

  Falls back to the default prompt override from ``promptoverride.txt`` when
  the database value is NULL, ensuring the file-based default is always live.
  """
  with _cache_lock:
    global_cached = _prompt_cache.get(GLOBAL_CHAT_ID, _MISSING)
  if global_cached is not _MISSING:
    return global_cached  # type: ignore[return-value]
  # Not in cache — read from DB and cache it.
  row = _get_global_setting_row()
  value = row['prompt'] if row is not None else None
  # Fall back to the default prompt override from promptoverride.txt
  if value is None:
    value = _DEFAULT_PROMPT_OVERRIDE
  with _cache_lock:
    _prompt_cache[GLOBAL_CHAT_ID] = value
  return value


@_db_resilient('settings')
def set_prompt(chat_id: str, prompt: Optional[str]) -> None:
  _ensure_split_ready()
  _ensure_chat_row(chat_id)
  conn = _get_settings_conn()
  conn.execute(
    'UPDATE chat_settings SET prompt = ?, updated_at = datetime(?) WHERE chat_id = ?',
    (prompt, 'now', chat_id),
  )
  conn.commit()
  # Invalidate per-chat caches for this row (permission, mode, triggers, …).
  _pop_all_chat_caches(chat_id)
  # When the __global__ prompt changes, every per-chat prompt cache entry that
  # may hold a stale global-fallback value must also be evicted — clearing the
  # entire dict is the simplest safe approach.
  if chat_id == GLOBAL_CHAT_ID:
    with _cache_lock:
      _prompt_cache.clear()
  # Re-cache the new value so the next get_prompt() hits the cache.
  with _cache_lock:
    _prompt_cache[chat_id] = prompt
  logger.info('DB set_prompt chat_id=%s len=%s', chat_id, len(prompt) if prompt else 0)


@_db_resilient('settings')
def get_permission(chat_id: str) -> int:
  """Return the permission level (0-3) for *chat_id*. Default ``0``."""
  with _cache_lock:
    cached = _permission_cache.get(chat_id, _MISSING)
  if cached is not _MISSING:
    return cached  # type: ignore[return-value]

  row = _get_setting_row(chat_id)
  value = int(row['permission']) if row is not None else 0
  with _cache_lock:
    _permission_cache[chat_id] = value
  return value


@_db_resilient('settings')
def set_permission(chat_id: str, level: int) -> None:
  clamped = max(0, min(3, int(level)))
  _ensure_split_ready()
  _ensure_chat_row(chat_id)
  conn = _get_settings_conn()
  conn.execute(
    'UPDATE chat_settings SET permission = ?, updated_at = datetime(?) WHERE chat_id = ?',
    (clamped, 'now', chat_id),
  )
  conn.commit()
  _pop_all_chat_caches(chat_id)
  with _cache_lock:
    _permission_cache[chat_id] = clamped
  logger.info('DB set_permission chat_id=%s level=%s', chat_id, clamped)


@_db_resilient('settings')
def clear_settings(chat_id: str) -> None:
  """Remove all stored settings for *chat_id*."""
  _ensure_split_ready()
  conn = _get_settings_conn()
  conn.execute('DELETE FROM chat_settings WHERE chat_id = ?', (chat_id,))
  conn.commit()
  if chat_id == GLOBAL_CHAT_ID:
    # Clearing the global row affects every chat that falls back to it.
    with _cache_lock:
      _prompt_cache.clear()
  else:
    with _cache_lock:
      _prompt_cache.pop(chat_id, None)
  _pop_all_chat_caches(chat_id)


def permission_description(level: int) -> str:
  """Human-readable description of a permission level."""
  mapping = {
    0: 'all moderation FORBIDDEN',
    1: 'delete ALLOWED',
    2: 'delete & mute ALLOWED',
    3: 'delete, mute & kick ALLOWED',
  }
  return mapping.get(level, mapping[0])


def permission_allows_delete(level: int) -> bool:
  return level >= 1


def permission_allows_mute(level: int) -> bool:
  return level >= 2


def permission_allows_kick(level: int) -> bool:
  return level >= 3


# ---------------------------------------------------------------------------
# LLM2 Model Management
# ---------------------------------------------------------------------------

_llm2_model_cache: dict[str, Optional[str]] = {}
_default_llm2_model_cache: Optional[dict] = None


@_db_resilient('settings')
def get_default_llm2_model() -> Optional[dict]:
  """Return the default model (lowest sort_order, is_active=1)."""
  global _default_llm2_model_cache
  if _default_llm2_model_cache is not None:
    return _default_llm2_model_cache
  _ensure_split_ready()
  conn = _get_settings_conn()
  row = conn.execute(
    'SELECT model_id, display_name, description, vision_support FROM llm_models WHERE is_active = 1 ORDER BY sort_order ASC LIMIT 1'
  ).fetchone()
  if row:
    _default_llm2_model_cache = {
      'model_id': row['model_id'],
      'display_name': row['display_name'],
      'description': row['description'],
      'vision_support': bool(row['vision_support']),
    }
  return _default_llm2_model_cache


@_db_resilient('settings')
def get_llm2_model(chat_id: str) -> Optional[str]:
  """Return the model_id for chat_id, or None if not set."""
  with _cache_lock:
    cached = _llm2_model_cache.get(chat_id, _MISSING)
  if cached is not _MISSING:
    return cached if cached is not None else None

  row = _get_setting_row(chat_id)
  value = row['llm2_model'] if row is not None else None
  with _cache_lock:
    _llm2_model_cache[chat_id] = value
  return value


@_db_resilient('settings')
def get_model_vision_support(chat_id: str) -> bool:
  """Return True if the active model for chat_id supports vision (multimodal input).

  Resolves the chat-specific model first, then falls back to the default model.
  Returns False if no model is configured or if the model does not support vision.
  """
  model_id = get_llm2_model(chat_id)
  default_model = get_default_llm2_model()

  # Determine which model is active
  active_model_id = model_id if model_id else (default_model['model_id'] if default_model else None)
  if not active_model_id:
    logger.debug('get_model_vision_support: no active model for chat_id=%s (model_id=%s, default=%s)', chat_id, model_id, default_model)
    return False

  # If using chat-specific model, look it up
  if model_id and model_id != (default_model['model_id'] if default_model else None):
    _ensure_split_ready()
    conn = _get_settings_conn()
    row = conn.execute(
      'SELECT vision_support FROM llm_models WHERE model_id = ? AND is_active = 1',
      (model_id,),
    ).fetchone()
    result = bool(row['vision_support']) if row else False
    logger.debug('get_model_vision_support: chat_id=%s model_id=%s (chat-specific) vision=%s', chat_id, model_id, result)
    return result

  # Using default model
  result = bool(default_model.get('vision_support', False)) if default_model else False
  logger.debug('get_model_vision_support: chat_id=%s model_id=%s (default) vision=%s', chat_id, active_model_id, result)
  return result


@_db_resilient('settings')
def set_llm2_model(chat_id: str, model_id: Optional[str]) -> None:
  _ensure_split_ready()
  _ensure_chat_row(chat_id)
  conn = _get_settings_conn()
  conn.execute(
    'UPDATE chat_settings SET llm2_model = ?, updated_at = datetime(?) WHERE chat_id = ?',
    (model_id, 'now', chat_id),
  )
  conn.commit()
  _pop_all_chat_caches(chat_id)
  with _cache_lock:
    _llm2_model_cache[chat_id] = model_id
  logger.info('DB set_llm2_model chat_id=%s model_id=%s', chat_id, model_id)


@_db_resilient('settings')
def get_all_active_models() -> list[dict]:
  """Return all active models ordered by sort_order."""
  _ensure_split_ready()
  conn = _get_settings_conn()
  rows = conn.execute(
    'SELECT model_id, display_name, description, sort_order, vision_support FROM llm_models WHERE is_active = 1 ORDER BY sort_order ASC'
  ).fetchall()
  return [
    {
      'model_id': row['model_id'],
      'display_name': row['display_name'],
      'description': row['description'],
      'sort_order': row['sort_order'],
      'vision_support': bool(row['vision_support']),
    }
    for row in rows
  ]


@_db_resilient('settings')
def get_all_models() -> list[dict]:
  """Return all models (active and inactive) ordered by sort_order."""
  _ensure_split_ready()
  conn = _get_settings_conn()
  rows = conn.execute(
    'SELECT model_id, display_name, description, is_active, sort_order, vision_support FROM llm_models ORDER BY sort_order ASC'
  ).fetchall()
  return [
    {
      'model_id': row['model_id'],
      'display_name': row['display_name'],
      'description': row['description'],
      'is_active': bool(row['is_active']),
      'sort_order': row['sort_order'],
      'vision_support': bool(row['vision_support']),
    }
    for row in rows
  ]


def clear_llm2_model_cache(chat_id: Optional[str] = None) -> None:
  """Clear the LLM2 model cache. If chat_id is provided, only that chat is invalidated. Otherwise, all chats are cleared."""
  global _llm2_model_cache
  with _cache_lock:
    if chat_id is not None:
      if chat_id in _llm2_model_cache:
        del _llm2_model_cache[chat_id]
        logger.debug('Cleared LLM2 model cache for chat_id=%s', chat_id)
    else:
      _llm2_model_cache.clear()
      logger.debug('Cleared all LLM2 model caches')


def clear_default_llm2_model_cache() -> None:
  """Clear the default LLM2 model cache."""
  global _default_llm2_model_cache
  _default_llm2_model_cache = None
  logger.debug('Cleared default LLM2 model cache')


def clear_subagent_enabled_cache(chat_id: Optional[str] = None) -> None:
  """Drop the subagent-enabled cache for *chat_id* (or all chats).

  Called when Node writes to chat_settings.subagent_enabled via
  /subagent on/off so the next get_subagent_enabled() re-reads from
  disk instead of returning the stale cached value.
  """
  with _cache_lock:
    if chat_id is not None:
      if chat_id in _subagent_enabled_cache:
        del _subagent_enabled_cache[chat_id]
        logger.debug('Cleared subagent_enabled cache for chat_id=%s', chat_id)
    else:
      _subagent_enabled_cache.clear()
      logger.debug('Cleared all subagent_enabled caches')


def reset_settings_connection() -> None:
  """Close and discard the settings DB connection so it is re-opened from disk on next access.

  This is needed when Node.js writes changes to settings.db (model additions,
  deletions, etc.) that Python's cached SQLite connection may not see due to
  WAL snapshot staleness.  Closing the connection forces a fresh read.
  """
  conn: sqlite3.Connection | None = _cached_connection('settings')
  if conn is not None:
    try:
      conn.close()
    except Exception:
      pass
    _clear_cached_connection('settings')
  # Also clear in-memory caches so next reads go to the (fresh) DB.
  # Every cache backed by settings.db must be listed here, otherwise a
  # caller that uses reset_settings_connection() to "force a re-read"
  # (e.g. the invalidate_default_model WS handler) would still serve
  # stale values from the missing cache. subagent_enabled lives in the
  # chat_settings table since the storage-unification fix, so its cache
  # is included here too.
  global _default_llm2_model_cache
  _default_llm2_model_cache = None
  with _cache_lock:
    _prompt_cache.clear()
    _permission_cache.clear()
    _mode_cache.clear()
    _triggers_cache.clear()
    _llm2_model_cache.clear()
    _subagent_enabled_cache.clear()
  logger.debug('Settings DB connection reset; caches cleared')


def invalidate_chat_caches(chat_id: str) -> None:
  """Drop every per-chat cache backed by settings.db for *chat_id*.

  Called from the WS handler when Node writes a chat-scoped setting
  (mode, prompt, permission, triggers, LLM2 model, subagent_enabled) so
  the next read returns the freshly-written value instead of a stale
  cached snapshot. Without this hook the bridge would keep serving the
  pre-write value until the process restarted.

  The settings DB connection is also reset because SQLite's WAL snapshot
  on Python's cached connection may not see writes made by Node's
  separate connection — closing it forces a fresh read on next access.
  """
  if not chat_id:
    return
  with _cache_lock:
    _prompt_cache.pop(chat_id, None)
    _permission_cache.pop(chat_id, None)
    _mode_cache.pop(chat_id, None)
    _triggers_cache.pop(chat_id, None)
    _llm2_model_cache.pop(chat_id, None)
    _subagent_enabled_cache.pop(chat_id, None)
  reset_settings_connection()
  logger.debug('Per-chat settings caches invalidated chat_id=%s', chat_id)


def close_all_connections() -> None:
  """Gracefully close all SQLite connections for every tenant opened on this
  thread.

  Should be called on shutdown to ensure WAL files are checkpointed and
  connections are released cleanly, preventing "database disk image is malformed"
  errors on the next startup. Iterates the path-keyed connection store so
  multi-account (Step 33) connections under every ``<folder_path>/db/`` are
  closed, not just the current tenant's.
  """
  store = _conn_store()
  for key, conn in list(store.items()):
    if conn is None:
      store.pop(key, None)
      continue
    try:
      # Attempt WAL checkpoint before closing so the main DB file is up-to-date
      conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
      conn.close()
    except Exception:
      try:
        conn.close()
      except Exception:
        pass
    store.pop(key, None)
  logger.info('All SQLite connections closed')


def checkpoint_all_dbs() -> None:
  """Checkpoint WAL files for all open databases (every tenant) to keep them
  small and reduce the risk of corruption after unclean shutdowns.
  """
  store = _conn_store()
  for (kind, path), conn in list(store.items()):
    if conn is None:
      continue
    try:
      conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
      logger.debug('WAL checkpoint completed for %s (%s)', kind, path)
    except Exception as exc:
      logger.warning('WAL checkpoint failed for %s (%s): %s', kind, path, exc)


@_db_resilient('settings')
def add_model(model_id: str, display_name: str, description: str = '', sort_order: Optional[int] = None, vision_support: bool = False) -> bool:
  """Add a new model. Returns False if model_id already exists."""
  global _default_llm2_model_cache
  _default_llm2_model_cache = None
  _ensure_split_ready()
  conn = _get_settings_conn()
  if sort_order is None:
    max_order_row = conn.execute('SELECT MAX(sort_order) as max_order FROM llm_models').fetchone()
    sort_order = (max_order_row['max_order'] or -1) + 1
  try:
    conn.execute(
      """
      INSERT INTO llm_models (model_id, display_name, description, sort_order, vision_support)
      VALUES (?, ?, ?, ?, ?)
      """,
      (model_id, display_name, description, sort_order, 1 if vision_support else 0),
    )
    conn.commit()
    logger.info('DB add_model model_id=%s display_name=%s vision_support=%s', model_id, display_name, vision_support)
    return True
  except sqlite3.IntegrityError:
    return False


@_db_resilient('settings')
def update_model(model_id: str, display_name: Optional[str] = None, description: Optional[str] = None, is_active: Optional[bool] = None, sort_order: Optional[int] = None, vision_support: Optional[bool] = None) -> bool:
  """Update a model. Returns False if model_id not found."""
  global _default_llm2_model_cache
  _default_llm2_model_cache = None
  _ensure_split_ready()
  conn = _get_settings_conn()
  existing = conn.execute('SELECT * FROM llm_models WHERE model_id = ?', (model_id,)).fetchone()
  if not existing:
    return False
  updates = []
  values = []
  if display_name is not None:
    updates.append('display_name = ?')
    values.append(display_name)
  if description is not None:
    updates.append('description = ?')
    values.append(description)
  if is_active is not None:
    updates.append('is_active = ?')
    values.append(1 if is_active else 0)
  if sort_order is not None:
    updates.append('sort_order = ?')
    values.append(sort_order)
  if vision_support is not None:
    updates.append('vision_support = ?')
    values.append(1 if vision_support else 0)
  if not updates:
    return True
  values.append(model_id)
  conn.execute(f"UPDATE llm_models SET {', '.join(updates)} WHERE model_id = ?", values)
  conn.commit()
  logger.info('DB update_model model_id=%s', model_id)
  return True


@_db_resilient('settings')
def delete_model(model_id: str) -> bool:
  """Delete a model. Returns False if model_id not found."""
  global _default_llm2_model_cache
  _default_llm2_model_cache = None
  _ensure_split_ready()
  conn = _get_settings_conn()
  existing = conn.execute('SELECT model_id FROM llm_models WHERE model_id = ?', (model_id,)).fetchone()
  if not existing:
    return False
  affected_rows = conn.execute('SELECT chat_id FROM chat_settings WHERE llm2_model = ?', (model_id,)).fetchall()
  with _cache_lock:
    for row in affected_rows:
      _llm2_model_cache.pop(row['chat_id'], None)
  conn.execute('DELETE FROM llm_models WHERE model_id = ?', (model_id,))
  conn.execute('UPDATE chat_settings SET llm2_model = NULL WHERE llm2_model = ?', (model_id,))
  conn.commit()
  logger.info('DB delete_model model_id=%s', model_id)
  return True


# ---------------------------------------------------------------------------
# Mode / Triggers
# ---------------------------------------------------------------------------

@_db_resilient('settings')
def get_mode(chat_id: str) -> str:
  """Return the chat mode ('auto', 'prefix', or 'hybrid'). Default 'prefix'."""
  with _cache_lock:
    cached = _mode_cache.get(chat_id, _MISSING)
  if cached is not _MISSING:
    return cached  # type: ignore[return-value]

  row = _get_setting_row(chat_id)
  value = row['mode'] if row is not None else DEFAULT_MODE
  if value not in VALID_MODES:
    value = DEFAULT_MODE
  with _cache_lock:
    _mode_cache[chat_id] = value
  return value


@_db_resilient('settings')
def set_mode(chat_id: str, mode: str) -> None:
  if mode not in VALID_MODES:
    mode = DEFAULT_MODE
  _ensure_split_ready()
  _ensure_chat_row(chat_id)
  conn = _get_settings_conn()
  conn.execute(
    'UPDATE chat_settings SET mode = ?, updated_at = datetime(?) WHERE chat_id = ?',
    (mode, 'now', chat_id),
  )
  conn.commit()
  _pop_all_chat_caches(chat_id)
  with _cache_lock:
    _mode_cache[chat_id] = mode
  logger.info('DB set_mode chat_id=%s mode=%s', chat_id, mode)


@_db_resilient('settings')
def get_triggers(chat_id: str) -> set[str]:
  """Return the set of enabled trigger types for *chat_id*."""
  with _cache_lock:
    cached = _triggers_cache.get(chat_id, _MISSING)
  if cached is not _MISSING:
    raw = cached  # type: ignore[assignment]
  else:
    row = _get_setting_row(chat_id)
    raw = row['triggers'] if row is not None else DEFAULT_TRIGGERS
    with _cache_lock:
      _triggers_cache[chat_id] = raw
  return {t.strip().lower() for t in raw.split(',') if t.strip().lower() in VALID_TRIGGERS}


@_db_resilient('settings')
def set_triggers(chat_id: str, triggers: set[str]) -> None:
  valid = {t for t in triggers if t in VALID_TRIGGERS}
  raw = ','.join(sorted(valid)) if valid else ''
  _ensure_split_ready()
  _ensure_chat_row(chat_id)
  conn = _get_settings_conn()
  conn.execute(
    'UPDATE chat_settings SET triggers = ?, updated_at = datetime(?) WHERE chat_id = ?',
    (raw, 'now', chat_id),
  )
  conn.commit()
  _pop_all_chat_caches(chat_id)
  with _cache_lock:
    _triggers_cache[chat_id] = raw
  logger.info('DB set_triggers chat_id=%s triggers=%s', chat_id, raw)


# ---------------------------------------------------------------------------
# SubAgent toggle
# ---------------------------------------------------------------------------

@_db_resilient('settings')
def get_subagent_enabled(chat_id: str) -> bool:
  """Return whether subagent is enabled for *chat_id*. Default False."""
  with _cache_lock:
    cached = _subagent_enabled_cache.get(chat_id, _MISSING)
  if cached is not _MISSING:
    return cached  # type: ignore[return-value]

  row = _get_setting_row(chat_id)
  value = bool(row['subagent_enabled']) if row is not None else DEFAULT_SUBAGENT_ENABLED
  with _cache_lock:
    _subagent_enabled_cache[chat_id] = value
  return value


@_db_resilient('settings')
def set_subagent_enabled(chat_id: str, enabled: bool) -> None:
  enabled = bool(enabled)
  _ensure_split_ready()
  _ensure_chat_row(chat_id)
  conn = _get_settings_conn()
  conn.execute(
    'UPDATE chat_settings SET subagent_enabled = ?, updated_at = datetime(?) WHERE chat_id = ?',
    (1 if enabled else 0, 'now', chat_id),
  )
  conn.commit()
  _pop_all_chat_caches(chat_id)
  with _cache_lock:
    _subagent_enabled_cache[chat_id] = enabled
  logger.info('DB set_subagent_enabled chat_id=%s enabled=%s', chat_id, enabled)


# ---------------------------------------------------------------------------
# Idle trigger
# ---------------------------------------------------------------------------

@_db_resilient('settings')
def get_idle_trigger(chat_id: str) -> Optional[tuple[int, int]]:
  """Return (min, max) for the idle trigger, or None if not set."""
  row = _get_setting_row(chat_id)
  min_val = row['idle_trigger_min'] if row is not None else None
  if min_val is None:
    return None
  max_val = row['idle_trigger_max'] if row is not None else None
  return (int(min_val), int(max_val) if max_val is not None else int(min_val))


@_db_resilient('settings')
def set_idle_trigger(chat_id: str, min_val: Optional[int], max_val: Optional[int]) -> None:
  _ensure_split_ready()
  _ensure_chat_row(chat_id)
  conn = _get_settings_conn()
  conn.execute(
    'UPDATE chat_settings SET idle_trigger_min = ?, idle_trigger_max = ?, updated_at = datetime(?) WHERE chat_id = ?',
    (min_val, max_val, 'now', chat_id),
  )
  conn.commit()
  _pop_all_chat_caches(chat_id)
  logger.info('DB set_idle_trigger chat_id=%s min=%s max=%s', chat_id, min_val, max_val)


# ---------------------------------------------------------------------------
# Dashboard stats persistence
# ---------------------------------------------------------------------------

@_db_resilient('stats')
def upsert_stats_batch(rows: list[tuple[str, str, str, str, int]]) -> None:
  """Batch upsert stat counters: [(chat_id, period_type, period_key, stat_key, increment), ...]."""
  if not rows:
    return
  _ensure_split_ready()
  conn = _get_stats_conn()
  conn.executemany(
    """
    INSERT INTO chat_stats (chat_id, period_type, period_key, stat_key, stat_value)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, period_type, period_key, stat_key) DO UPDATE SET
      stat_value = stat_value + excluded.stat_value
    """,
    rows,
  )
  conn.commit()


@_db_resilient('stats')
def upsert_user_stats_batch(rows: list[tuple[str, str, str, str, str, int]]) -> None:
  """Batch upsert user invoke counters: [(chat_id, period_type, period_key, sender_ref, sender_name, increment), ...]."""
  if not rows:
    return
  _ensure_split_ready()
  conn = _get_stats_conn()
  conn.executemany(
    """
    INSERT INTO chat_user_stats (chat_id, period_type, period_key, sender_ref, sender_name, invoke_count)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, period_type, period_key, sender_ref) DO UPDATE SET
      invoke_count = invoke_count + excluded.invoke_count,
      sender_name = excluded.sender_name
    """,
    rows,
  )
  conn.commit()


@_db_resilient('stats')
def get_stats(chat_id: str, period_type: str, period_key: str) -> dict[str, int]:
  """Return {stat_key: stat_value} for a given chat and period."""
  _ensure_split_ready()
  conn = _get_stats_conn()
  rows = conn.execute(
    'SELECT stat_key, stat_value FROM chat_stats WHERE chat_id = ? AND period_type = ? AND period_key = ?',
    (chat_id, period_type, period_key),
  ).fetchall()
  return {row['stat_key']: row['stat_value'] for row in rows}


@_db_resilient('stats')
def get_top_users(chat_id: str, period_type: str, period_key: str, limit: int = 5) -> list[tuple[str, str, int]]:
  """Return top users [(sender_ref, sender_name, invoke_count), ...] for a period."""
  _ensure_split_ready()
  conn = _get_stats_conn()
  rows = conn.execute(
    """
    SELECT sender_ref, sender_name, invoke_count FROM chat_user_stats
    WHERE chat_id = ? AND period_type = ? AND period_key = ?
    ORDER BY invoke_count DESC LIMIT ?
    """,
    (chat_id, period_type, period_key, limit),
  ).fetchall()
  return [(row['sender_ref'], row['sender_name'], row['invoke_count']) for row in rows]


# ---------------------------------------------------------------------------
# Mute management
# ---------------------------------------------------------------------------

def _parse_muted_at(muted_at_str: str) -> float:
  """Parse ``datetime('now')`` format to epoch seconds."""
  from datetime import datetime, timezone
  try:
    dt = datetime.strptime(muted_at_str, '%Y-%m-%d %H:%M:%S')
    return dt.replace(tzinfo=timezone.utc).timestamp()
  except (ValueError, TypeError):
    return 0.0


def _is_mute_active(entry: dict) -> bool:
  """Check whether a mute entry is still active."""
  import time
  muted_at_epoch = _parse_muted_at(entry['muted_at'])
  if muted_at_epoch <= 0:
    return False
  expires_at = muted_at_epoch + entry['duration_m'] * 60
  return time.time() < expires_at


def _mute_remaining_minutes(entry: dict) -> int:
  """Return remaining mute minutes (0 if expired)."""
  import time
  muted_at_epoch = _parse_muted_at(entry['muted_at'])
  if muted_at_epoch <= 0:
    return 0
  expires_at = muted_at_epoch + entry['duration_m'] * 60
  remaining = (expires_at - time.time()) / 60
  return max(0, int(remaining))


@_db_resilient('moderation')
def add_mute(chat_id: str, sender_ref: str, duration_minutes: int) -> None:
  """Add or update a mute. Persists to DB and updates cache."""
  duration_minutes = max(1, min(1440, int(duration_minutes)))
  _ensure_split_ready()
  conn = _get_moderation_conn()
  conn.execute(
    """
    INSERT INTO chat_mutes (chat_id, sender_ref, muted_at, duration_m)
    VALUES (?, ?, datetime('now'), ?)
    ON CONFLICT(chat_id, sender_ref) DO UPDATE SET
      muted_at = datetime('now'),
      duration_m = excluded.duration_m
    """,
    (chat_id, sender_ref, duration_minutes),
  )
  conn.commit()
  from datetime import datetime, timezone
  now_str = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
  with _cache_lock:
    if chat_id not in _mute_cache:
      _mute_cache[chat_id] = {}
    _mute_cache[chat_id][sender_ref] = {
      'muted_at': now_str,
      'duration_m': duration_minutes,
      'notified': False,
    }
  logger.info('mute added chat_id=%s sender_ref=%s duration=%sm', chat_id, sender_ref, duration_minutes)


@_db_resilient('moderation')
def remove_mute(chat_id: str, sender_ref: str) -> None:
  """Remove a mute from DB and cache."""
  _ensure_split_ready()
  conn = _get_moderation_conn()
  conn.execute(
    'DELETE FROM chat_mutes WHERE chat_id = ? AND sender_ref = ?',
    (chat_id, sender_ref),
  )
  conn.commit()
  with _cache_lock:
    if chat_id in _mute_cache:
      _mute_cache[chat_id].pop(sender_ref, None)
  logger.info('mute removed chat_id=%s sender_ref=%s', chat_id, sender_ref)


@_db_resilient('moderation')
def clear_mutes(chat_id: str) -> None:
  """Remove all mutes for a chat (used on bot demotion)."""
  _ensure_split_ready()
  conn = _get_moderation_conn()
  conn.execute('DELETE FROM chat_mutes WHERE chat_id = ?', (chat_id,))
  conn.commit()
  with _cache_lock:
    _mute_cache.pop(chat_id, None)
  logger.info('all mutes cleared chat_id=%s', chat_id)


@_db_resilient('moderation')
def is_muted(chat_id: str, sender_ref: str) -> bool:
  """Check if a user is currently muted (cache-first, instant)."""
  with _cache_lock:
    chat_mutes = _mute_cache.get(chat_id)
    if chat_mutes is not None:
      entry = chat_mutes.get(sender_ref)
      if entry is not None:
        if _is_mute_active(entry):
          return True
        # Expired — clean up cache
        chat_mutes.pop(sender_ref, None)
        return False
      return False

  _ensure_split_ready()
  conn = _get_moderation_conn()
  row = conn.execute(
    'SELECT muted_at, duration_m FROM chat_mutes WHERE chat_id = ? AND sender_ref = ?',
    (chat_id, sender_ref),
  ).fetchone()
  if row is None:
    return False
  entry = {
    'muted_at': row['muted_at'],
    'duration_m': int(row['duration_m']),
    'notified': False,
  }
  active = _is_mute_active(entry)
  with _cache_lock:
    if chat_id not in _mute_cache:
      _mute_cache[chat_id] = {}
    if active:
      _mute_cache[chat_id][sender_ref] = entry
    else:
      conn.execute(
        'DELETE FROM chat_mutes WHERE chat_id = ? AND sender_ref = ?',
        (chat_id, sender_ref),
      )
      conn.commit()
  return active


def is_mute_notified(chat_id: str, sender_ref: str) -> bool:
  """Check if the first-delete notification was already sent for this mute."""
  with _cache_lock:
    chat_mutes = _mute_cache.get(chat_id, {})
    entry = chat_mutes.get(sender_ref)
    if entry is None:
      return False
    return bool(entry.get('notified'))


def mark_mute_notified(chat_id: str, sender_ref: str) -> None:
  """Mark that the first-delete notification has been sent."""
  with _cache_lock:
    chat_mutes = _mute_cache.get(chat_id, {})
    entry = chat_mutes.get(sender_ref)
    if entry is not None:
      entry['notified'] = True


def get_mute_remaining_minutes(chat_id: str, sender_ref: str) -> int:
  """Return remaining mute minutes for a user (0 if not muted)."""
  with _cache_lock:
    chat_mutes = _mute_cache.get(chat_id, {})
    entry = chat_mutes.get(sender_ref)
    if entry is not None:
      return _mute_remaining_minutes(entry)
  return 0


# ---------------------------------------------------------------------------
# Activation (read-only, safety net for Python side)
# ---------------------------------------------------------------------------

@_db_resilient('settings')
def is_chat_activated(chat_id: str) -> bool:
  """Return True if the chat is activated and not expired.

  This is a safety net — the primary gate lives in the Node.js gateway which
  drops messages from unactivated chats before they reach Python.  The Python
  side checks again in case of race conditions or WebSocket reconnection
  artefacts.
  """
  _ensure_split_ready()
  conn = _get_settings_conn()
  row = conn.execute(
    'SELECT expires_at FROM chat_activations WHERE chat_id = ?',
    (chat_id,)
  ).fetchone()
  if row is None:
    return False
  expires_at = row['expires_at'] if row is not None else None
  if expires_at is None:
    return True
  try:
    from datetime import datetime
    expiry = datetime.fromisoformat(expires_at)
    return expiry > datetime.now()
  except (ValueError, TypeError):
    return True
