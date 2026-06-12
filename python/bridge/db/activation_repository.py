"""Activation repository (read-only safety net for the Python side) — split out
of ``bridge/db.py`` (Step 11). SQL and signature unchanged.
"""
from __future__ import annotations

from .core import (
    _db_resilient,
    _ensure_split_ready,
    _get_settings_conn,
)


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
