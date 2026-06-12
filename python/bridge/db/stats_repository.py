"""Dashboard stats repository (counter + per-user invoke batches) — split out
of ``bridge/db.py`` (Step 11). SQL and signatures unchanged.
"""
from __future__ import annotations

from .core import (
    _db_resilient,
    _ensure_split_ready,
    _get_stats_conn,
)


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
