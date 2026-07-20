"""Regression coverage for persisted mute-cache hydration."""
from __future__ import annotations

from bridge.db import (
  _mute_cache,
  add_mute,
  close_all_connections,
  is_muted,
  tenant_db_context,
)


def test_restart_cache_hydrates_each_persisted_muted_sender(tmp_path):
  """Loading one mute must not make other persisted mutes look absent."""
  with tenant_db_context(str(tmp_path)):
    try:
      add_mute("group@g.us", "sender-a", 30)
      add_mute("group@g.us", "sender-b", 30)

      # Simulate a bridge restart: rows remain on disk, connections and the
      # process-local cache do not.
      close_all_connections()
      _mute_cache.clear()

      assert is_muted("group@g.us", "sender-a") is True
      assert is_muted("group@g.us", "sender-b") is True
    finally:
      close_all_connections()
      _mute_cache.clear()
