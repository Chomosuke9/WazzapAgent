"""Tests for db.py resilience features.

Covers:
  - Auto-recovery when the on-disk DB becomes corrupt mid-process. The
    original bug was that once a connection was cached on the thread, any
    "database disk image is malformed" error would loop forever (every
    subsequent query reused the same broken handle).
  - Stale WAL cleanup before recreating the main file.
  - Cache invalidation after recovery so callers don't keep returning
    pre-corruption values.
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bridge import db as db_mod  # noqa: E402


@pytest.fixture(autouse=True)
def _isolate_db(tmp_path, monkeypatch):
  """Point every db_mod helper at a per-test tmp directory."""
  monkeypatch.setenv("DATA_DIR", str(tmp_path))
  monkeypatch.setattr(db_mod, "_SETTINGS_DB_PATH", None)
  monkeypatch.setattr(db_mod, "_STATS_DB_PATH", None)
  monkeypatch.setattr(db_mod, "_MODERATION_DB_PATH", None)
  for attr in ("settings_conn", "stats_conn", "moderation_conn"):
    if hasattr(db_mod._LOCAL, attr):
      try:
        getattr(db_mod._LOCAL, attr).close()
      except Exception:
        pass
      setattr(db_mod._LOCAL, attr, None)
  with db_mod._cache_lock:
    db_mod._prompt_cache.clear()
    db_mod._permission_cache.clear()
    db_mod._mode_cache.clear()
    db_mod._triggers_cache.clear()
    db_mod._subagent_enabled_cache.clear()
    db_mod._llm2_model_cache.clear()
    db_mod._mute_cache.clear()
  db_mod._default_llm2_model_cache.clear()
  yield


def _corrupt(path: Path) -> None:
  """Overwrite *path* with bytes that decisively are not a SQLite file."""
  with open(path, "wb") as fh:
    fh.write(b"NOT A DATABASE\x00" * 64)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def test_is_db_corruption_error_recognises_known_messages():
  assert db_mod._is_db_corruption_error(
    sqlite3.DatabaseError("database disk image is malformed")
  )
  assert db_mod._is_db_corruption_error(
    sqlite3.DatabaseError("file is not a database")
  )
  assert not db_mod._is_db_corruption_error(
    sqlite3.OperationalError("database is locked")
  )
  assert not db_mod._is_db_corruption_error(ValueError("nope"))


def test_recover_corrupt_db_strips_stale_wal_files(tmp_path):
  # Probe-first recovery only quarantines sidecars when the MAIN image is
  # actually corrupt — a healthy DB is left untouched so its committed-but-
  # uncheckpointed WAL frames are never discarded. Corrupt the main file so
  # recovery engages.
  db_path = tmp_path / "stale.db"
  _corrupt(db_path)

  # Plant stale WAL/SHM alongside the corrupt main file.
  wal = db_path.with_suffix(db_path.suffix + "-wal")
  shm = db_path.with_suffix(db_path.suffix + "-shm")
  wal.write_bytes(b"\x00" * 32)
  shm.write_bytes(b"\x00" * 32)
  assert wal.exists() and shm.exists()

  db_mod._recover_corrupt_db(db_path)

  # Recovery quarantines the stale sidecars (renamed aside, not deleted, so
  # evidence is preserved) — the original paths are gone.
  assert not wal.exists()
  assert not shm.exists()
  assert wal.with_name(wal.name + ".corrupted.bak").exists()

  # A fresh connection recreates an empty, usable DB in the freed slot.
  reopened = sqlite3.connect(str(db_path))
  reopened.execute("CREATE TABLE t (k INTEGER PRIMARY KEY)")
  reopened.close()


def test_recover_corrupt_db_backs_up_unrecoverable_main_file(tmp_path):
  db_path = tmp_path / "broken.db"
  _corrupt(db_path)
  db_mod._recover_corrupt_db(db_path)

  # Original file moved aside; an empty main file slot is free for
  # sqlite3.connect to recreate.
  backup = db_path.with_suffix(db_path.suffix + ".corrupted.bak")
  assert backup.exists(), "corrupt DB should be renamed as .corrupted.bak"
  assert backup.read_bytes().startswith(b"NOT A DATABASE")
  assert not db_path.exists()


# ---------------------------------------------------------------------------
# End-to-end resilience: a public read survives runtime corruption
# ---------------------------------------------------------------------------

def test_get_subagent_enabled_recovers_from_runtime_corruption(tmp_path):
  """Reproduce the original bug: the bridge was crashing on every message
  with ``database disk image is malformed`` because the cached connection
  kept hitting the same poisoned page. After this fix the public helper
  must still return a value (the schema default is False)."""
  # Force the connection + tables to exist so corruption can hit a real DB.
  assert db_mod.get_subagent_enabled("chat-A") is False

  db_path = db_mod._resolve_settings_db_path()

  # Drop the cached connection so corruption isn't obscured by a stale handle.
  db_mod._drop_cached_connection("settings")
  # Wipe WAL/SHM too — otherwise SQLite may serve from the WAL frame and
  # miss our corruption.
  for ext in ("-wal", "-shm"):
    extra = db_path.with_suffix(db_path.suffix + ext)
    if extra.exists():
      extra.unlink()

  _corrupt(db_path)

  # First call after corruption must not raise; the resilient wrapper
  # detects the malformed file, recreates it, and retries.
  result = db_mod.get_subagent_enabled("chat-A")
  assert result is False  # default for a freshly recreated table

  # Subsequent calls should keep working without further recovery.
  assert db_mod.get_subagent_enabled("chat-B") is False


def test_set_then_get_after_recovery_uses_fresh_db(tmp_path):
  db_mod.set_subagent_enabled("chat-X", True)
  assert db_mod.get_subagent_enabled("chat-X") is True

  db_path = db_mod._resolve_settings_db_path()
  db_mod._drop_cached_connection("settings")
  for ext in ("-wal", "-shm"):
    extra = db_path.with_suffix(db_path.suffix + ext)
    if extra.exists():
      extra.unlink()
  _corrupt(db_path)
  # Bypass the in-memory cache so the read actually hits the corrupt file.
  with db_mod._cache_lock:
    db_mod._subagent_enabled_cache.clear()

  # The recovery wrapper detects "not a database", recreates the file, and
  # retries. The recreated DB is empty, so the previous True is gone — the
  # contract is "no exception", not "data preservation".
  assert db_mod.get_subagent_enabled("chat-X") is False

  # Writes after recovery persist normally.
  db_mod.set_subagent_enabled("chat-X", True)
  db_mod._drop_cached_connection("settings")
  with db_mod._cache_lock:
    db_mod._subagent_enabled_cache.clear()
  assert db_mod.get_subagent_enabled("chat-X") is True


def test_settings_pragmas_applied(tmp_path):
  conn = db_mod._get_settings_conn()
  journal_mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
  synchronous = conn.execute("PRAGMA synchronous").fetchone()[0]
  busy_timeout = conn.execute("PRAGMA busy_timeout").fetchone()[0]
  foreign_keys = conn.execute("PRAGMA foreign_keys").fetchone()[0]

  assert journal_mode.lower() == "wal"
  # This module deliberately uses synchronous=FULL (value 2) as an
  # anti-corruption durability measure; NORMAL would be 1.
  assert synchronous == 2
  assert busy_timeout >= 5000
  assert foreign_keys == 1


def test_stats_writes_recover_from_corruption(tmp_path):
  db_mod.upsert_stats_batch([("chat-1", "day", "2025-01-01", "msg", 1)])
  assert db_mod.get_stats("chat-1", "day", "2025-01-01") == {"msg": 1}

  db_path = db_mod._resolve_stats_db_path()
  db_mod._drop_cached_connection("stats")
  for ext in ("-wal", "-shm"):
    extra = db_path.with_suffix(db_path.suffix + ext)
    if extra.exists():
      extra.unlink()
  _corrupt(db_path)

  # Should not raise — recovery recreates the file with empty tables.
  db_mod.upsert_stats_batch([("chat-1", "day", "2025-01-01", "msg", 1)])
  assert db_mod.get_stats("chat-1", "day", "2025-01-01") == {"msg": 1}
