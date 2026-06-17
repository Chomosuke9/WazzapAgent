"""Moderation / mute repository — split out of ``bridge/db.py`` (Step 11).

Mute state is cached per tenant in ``_mute_cache`` (owned by
:mod:`bridge.db.core`); SQL and signatures are unchanged.
"""
from __future__ import annotations

from .core import (
    logger,
    _db_resilient,
    _cache_lock,
    _mute_cache,
    _tenant_cache_key,
    _ensure_split_ready,
    _get_moderation_conn,
)


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
def add_mute(chat_id: str, sender_ref: str, duration_minutes: int, sender_name: str | None = None) -> None:
  """Add or update a mute. Persists to DB and updates cache.

  ``sender_name`` (when known) is stored so the bot can show a human-readable
  name in mute/unmute confirmations and so :func:`list_active_mutes` can surface
  who is muted to LLM2. A re-mute that passes ``None`` keeps any previously
  stored name (``COALESCE``) instead of wiping it.
  """
  duration_minutes = max(1, min(1440, int(duration_minutes)))
  clean_name = (sender_name or "").strip() or None
  _ensure_split_ready()
  conn = _get_moderation_conn()
  conn.execute(
    """
    INSERT INTO chat_mutes (chat_id, sender_ref, muted_at, duration_m, sender_name)
    VALUES (?, ?, datetime('now'), ?, ?)
    ON CONFLICT(chat_id, sender_ref) DO UPDATE SET
      muted_at = datetime('now'),
      duration_m = excluded.duration_m,
      sender_name = COALESCE(excluded.sender_name, chat_mutes.sender_name)
    """,
    (chat_id, sender_ref, duration_minutes, clean_name),
  )
  conn.commit()
  from datetime import datetime, timezone
  now_str = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
  with _cache_lock:
    key = _tenant_cache_key(chat_id)
    if key not in _mute_cache:
      _mute_cache[key] = {}
    existing = _mute_cache[key].get(sender_ref) or {}
    _mute_cache[key][sender_ref] = {
      'muted_at': now_str,
      'duration_m': duration_minutes,
      'notified': False,
      'sender_name': clean_name or existing.get('sender_name'),
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
    key = _tenant_cache_key(chat_id)
    if key in _mute_cache:
      _mute_cache[key].pop(sender_ref, None)
  logger.info('mute removed chat_id=%s sender_ref=%s', chat_id, sender_ref)

@_db_resilient('moderation')
def clear_mutes(chat_id: str) -> None:
  """Remove all mutes for a chat (used on bot demotion)."""
  _ensure_split_ready()
  conn = _get_moderation_conn()
  conn.execute('DELETE FROM chat_mutes WHERE chat_id = ?', (chat_id,))
  conn.commit()
  with _cache_lock:
    _mute_cache.pop(_tenant_cache_key(chat_id), None)
  logger.info('all mutes cleared chat_id=%s', chat_id)

@_db_resilient('moderation')
def is_muted(chat_id: str, sender_ref: str) -> bool:
  """Check if a user is currently muted (cache-first, instant)."""
  with _cache_lock:
    chat_mutes = _mute_cache.get(_tenant_cache_key(chat_id))
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
    if _tenant_cache_key(chat_id) not in _mute_cache:
      _mute_cache[_tenant_cache_key(chat_id)] = {}
    if active:
      _mute_cache[_tenant_cache_key(chat_id)][sender_ref] = entry
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
    chat_mutes = _mute_cache.get(_tenant_cache_key(chat_id), {})
    entry = chat_mutes.get(sender_ref)
    if entry is None:
      return False
    return bool(entry.get('notified'))

def mark_mute_notified(chat_id: str, sender_ref: str) -> None:
  """Mark that the first-delete notification has been sent."""
  with _cache_lock:
    chat_mutes = _mute_cache.get(_tenant_cache_key(chat_id), {})
    entry = chat_mutes.get(sender_ref)
    if entry is not None:
      entry['notified'] = True

def get_mute_remaining_minutes(chat_id: str, sender_ref: str) -> int:
  """Return remaining mute minutes for a user (0 if not muted)."""
  with _cache_lock:
    chat_mutes = _mute_cache.get(_tenant_cache_key(chat_id), {})
    entry = chat_mutes.get(sender_ref)
    if entry is not None:
      return _mute_remaining_minutes(entry)
  return 0


@_db_resilient('moderation')
def list_active_mutes(chat_id: str) -> list[dict]:
  """Return the currently-active mutes for *chat_id*, authoritative from DB.

  Each item is ``{'sender_ref': str, 'name': str | None, 'remaining_minutes': int}``.
  Reads from disk (not cache-only) because a muted user's messages are deleted
  by the mute gate before they reach LLM2 history — so the in-memory cache may
  never have been populated for them. Expired rows are skipped (and lazily
  deleted) so the list reflects only mutes that are still in effect.
  """
  _ensure_split_ready()
  conn = _get_moderation_conn()
  rows = conn.execute(
    'SELECT sender_ref, muted_at, duration_m, sender_name FROM chat_mutes WHERE chat_id = ?',
    (chat_id,),
  ).fetchall()
  active: list[dict] = []
  expired: list[str] = []
  for row in rows:
    entry = {'muted_at': row['muted_at'], 'duration_m': int(row['duration_m'])}
    if _is_mute_active(entry):
      name = row['sender_name'] if 'sender_name' in row.keys() else None
      active.append({
        'sender_ref': row['sender_ref'],
        'name': (name or None),
        'remaining_minutes': _mute_remaining_minutes(entry),
      })
    else:
      expired.append(row['sender_ref'])
  if expired:
    conn.executemany(
      'DELETE FROM chat_mutes WHERE chat_id = ? AND sender_ref = ?',
      [(chat_id, ref) for ref in expired],
    )
    conn.commit()
    with _cache_lock:
      chat_mutes = _mute_cache.get(_tenant_cache_key(chat_id))
      if chat_mutes is not None:
        for ref in expired:
          chat_mutes.pop(ref, None)
  active.sort(key=lambda item: item['remaining_minutes'])
  return active
