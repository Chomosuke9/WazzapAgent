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

from ..log import setup_logging

logger = setup_logging()

_DEFAULT_DB_DIR = Path(__file__).resolve().parent.parent.parent.parent / 'data'
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
# Long-term memory cache: {(tenant, chat_id): [text, ...]} — the effective
# (global + per-chat) memory list injected into LLM2 every turn. Cleared
# wholesale on any settings invalidation (global memory affects every chat).
_memory_cache: dict = {}
# Mute cache: {chat_id: {sender_ref: {"muted_at": str, "duration_m": int, "notified": bool}}}
_mute_cache: dict[str, dict[str, dict]] = {}
_cache_lock = threading.Lock()


def _tenant_key() -> str:
  """The active tenant id (the ``_tenant_db_dir`` ContextVar), or ``''`` in the
  legacy single-account / global mode. Used to scope process-global caches that
  are per-tenant but NOT per-chat (e.g. the default LLM2 model), so two tenants
  don't read each other's value. Falls back to ``''`` when no tenant is bound."""
  return _tenant_db_dir.get() or ''


def _tenant_cache_key(chat_id: str) -> tuple[str, str]:
  """Compose the active tenant (the ``_tenant_db_dir`` ContextVar) with
  *chat_id* so the module-global in-memory caches above are isolated per
  tenant. Two tenants that share the same WhatsApp group (same ``chat_id``
  JID) must not read each other's cached settings. Falls back to ``''`` when
  no tenant is bound (legacy single-account / global mode)."""
  return (_tenant_key(), chat_id)

VALID_MODES = {'auto', 'prefix', 'hybrid'}
DEFAULT_MODE = 'prefix'
VALID_TRIGGERS = {'tag', 'tagall', 'reply', 'join', 'name'}
DEFAULT_TRIGGERS = 'tag,reply,name'
DEFAULT_SUBAGENT_ENABLED = False
GLOBAL_CHAT_ID = '__global__'
PROMPT_OVERRIDE_PATH = Path(__file__).resolve().parent.parent.parent / "promptoverride.txt"
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
      _memory_cache.clear()
      _llm2_model_cache.clear()
      _default_llm2_model_cache.clear()
    elif db_kind == 'moderation':
      _mute_cache.clear()


def _db_resilient(db_kind: str) -> Callable[[_F], _F]:
  """Decorator: recover once after on-disk corruption.

  SQLITE_BUSY / "database is locked" is handled by the connection's
  ``busy_timeout`` (``PRAGMA busy_timeout = DB_BUSY_TIMEOUT_MS``): SQLite parks
  on the contended lock and retries internally, only raising once that elapses.
  A synchronous ``time.sleep()`` retry layered on top would re-wait the full
  busy_timeout AND block the shared asyncio event loop (freezing every tenant /
  the WS pump), so we rely on busy_timeout alone for contention and only
  intervene here for genuine on-disk corruption.
  """
  def decorator(fn: _F) -> _F:
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):  # type: ignore[no-untyped-def]
      corruption_retries = 0
      while True:
        try:
          return fn(*args, **kwargs)
        except sqlite3.DatabaseError as exc:
          if not _is_db_corruption_error(exc) or corruption_retries >= 1:
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
          continue
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

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id            TEXT PRIMARY KEY,
      chat_id       TEXT NOT NULL,
      fire_at_ms    INTEGER NOT NULL,
      prompt        TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_key   TEXT NOT NULL,
      text        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories (scope_key, id);

    CREATE TABLE IF NOT EXISTS memory_mentions (
      scope_key   TEXT NOT NULL,
      sender_ref  TEXT NOT NULL,
      lid         TEXT NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (scope_key, sender_ref)
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
      chat_id     TEXT NOT NULL,
      sender_ref  TEXT NOT NULL,
      muted_at    TEXT NOT NULL DEFAULT (datetime('now')),
      duration_m  INTEGER NOT NULL DEFAULT 60,
      sender_name TEXT,
      PRIMARY KEY (chat_id, sender_ref)
    );
    """
  )
  # Migration: add sender_name to existing chat_mutes tables so the bot can
  # show a human-readable name in mute/unmute confirmations and surface the
  # list of currently-muted users (with their senderRef) to LLM2.
  try:
    conn.execute('ALTER TABLE chat_mutes ADD COLUMN sender_name TEXT')
    conn.commit()
  except sqlite3.OperationalError:
    pass


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
    _prompt_cache.pop(_tenant_cache_key(chat_id), None)
    _permission_cache.pop(_tenant_cache_key(chat_id), None)
    _mode_cache.pop(_tenant_cache_key(chat_id), None)
    _triggers_cache.pop(_tenant_cache_key(chat_id), None)
    _llm2_model_cache.pop(_tenant_cache_key(chat_id), None)
    _subagent_enabled_cache.pop(_tenant_cache_key(chat_id), None)


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


# ---------------------------------------------------------------------------
# LLM2 Model Management
# ---------------------------------------------------------------------------

# Per-chat LLM2 model cache, keyed by (tenant, chat_id) so two bot accounts
# present in the same WhatsApp group don't share/overwrite each other's model
# selection. The default-model cache is keyed by tenant id alone (it is not
# per-chat). Both fall back to the '' tenant slot in single-account / legacy
# mode, so single-account behaviour is unchanged.
_llm2_model_cache: dict[tuple[str, str], Optional[str]] = {}
_default_llm2_model_cache: dict[str, Optional[dict]] = {}


def clear_llm2_model_cache(chat_id: Optional[str] = None) -> None:
  """Clear the LLM2 model cache. If chat_id is provided, only that chat is invalidated. Otherwise, all chats are cleared."""
  with _cache_lock:
    if chat_id is not None:
      key = _tenant_cache_key(chat_id)
      if key in _llm2_model_cache:
        del _llm2_model_cache[key]
        logger.debug('Cleared LLM2 model cache for chat_id=%s', chat_id)
    else:
      _llm2_model_cache.clear()
      logger.debug('Cleared all LLM2 model caches')


def clear_default_llm2_model_cache() -> None:
  """Clear the default LLM2 model cache for the active tenant."""
  _default_llm2_model_cache.pop(_tenant_key(), None)
  logger.debug('Cleared default LLM2 model cache')


def clear_subagent_enabled_cache(chat_id: Optional[str] = None) -> None:
  """Drop the subagent-enabled cache for *chat_id* (or all chats).

  Called when Node writes to chat_settings.subagent_enabled via
  /subagent on/off so the next get_subagent_enabled() re-reads from
  disk instead of returning the stale cached value.
  """
  with _cache_lock:
    if chat_id is not None:
      key = _tenant_cache_key(chat_id)
      if key in _subagent_enabled_cache:
        del _subagent_enabled_cache[key]
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
  _default_llm2_model_cache.clear()
  with _cache_lock:
    _prompt_cache.clear()
    _permission_cache.clear()
    _mode_cache.clear()
    _triggers_cache.clear()
    _memory_cache.clear()
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
    _prompt_cache.pop(_tenant_cache_key(chat_id), None)
    _permission_cache.pop(_tenant_cache_key(chat_id), None)
    _mode_cache.pop(_tenant_cache_key(chat_id), None)
    _triggers_cache.pop(_tenant_cache_key(chat_id), None)
    _llm2_model_cache.pop(_tenant_cache_key(chat_id), None)
    _subagent_enabled_cache.pop(_tenant_cache_key(chat_id), None)
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


# ---------------------------------------------------------------------------
# Mode / Triggers
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# SubAgent toggle
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Idle trigger
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Dashboard stats persistence
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Mute management
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Activation (read-only, safety net for Python side)
# ---------------------------------------------------------------------------

