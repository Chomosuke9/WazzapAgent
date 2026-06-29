"""Per-chat settings repository (prompt, permission, mode, triggers,
subagent toggle, idle trigger) — split out of ``bridge/db.py`` (Step 11).

All functions, SQL and signatures are unchanged; the per-tenant ContextVar
routing, caches and ``_db_resilient`` resilience live in :mod:`bridge.db.core`.
"""
from __future__ import annotations

from typing import Optional

from .core import (
    logger,
    _db_resilient,
    _cache_lock,
    _MISSING,
    _prompt_cache,
    _permission_cache,
    _mode_cache,
    _triggers_cache,
    _subagent_enabled_cache,
    _memory_cache,
    _tenant_cache_key,
    _ensure_split_ready,
    _get_settings_conn,
    _get_setting_row,
    _get_global_setting_row,
    _ensure_chat_row,
    _pop_all_chat_caches,
    VALID_MODES,
    DEFAULT_MODE,
    VALID_TRIGGERS,
    DEFAULT_TRIGGERS,
    DEFAULT_SUBAGENT_ENABLED,
    GLOBAL_CHAT_ID,
    _DEFAULT_PROMPT_OVERRIDE,
)


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
    cached = _prompt_cache.get(_tenant_cache_key(chat_id), _MISSING)
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
      _prompt_cache[_tenant_cache_key(chat_id)] = raw

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
    global_cached = _prompt_cache.get(_tenant_cache_key(GLOBAL_CHAT_ID), _MISSING)
  if global_cached is not _MISSING:
    return global_cached  # type: ignore[return-value]
  # Not in cache — read from DB and cache it.
  row = _get_global_setting_row()
  value = row['prompt'] if row is not None else None
  # Fall back to the default prompt override from promptoverride.txt
  if value is None:
    value = _DEFAULT_PROMPT_OVERRIDE
  with _cache_lock:
    _prompt_cache[_tenant_cache_key(GLOBAL_CHAT_ID)] = value
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
    _prompt_cache[_tenant_cache_key(chat_id)] = prompt
  logger.info('DB set_prompt chat_id=%s len=%s', chat_id, len(prompt) if prompt else 0)

# ponytail: no set_join_prompt — only Node writes via /prompt join
def get_join_prompt() -> str:
  row = _get_settings_conn().execute(
    'SELECT value FROM bot_config WHERE key = ?', ('join_prompt',)
  ).fetchone()
  return row['value'] if row and row['value'] else "Introduce yourself to this group. Tell them your name and what you can do."

@_db_resilient('settings')
def get_memories(chat_id: str) -> list[str]:
  """Return the effective long-term memory list for *chat_id*.

  Combines the shared ``__global__`` memories (listed first) with the per-chat
  memories (listed after), each ordered oldest-first — the same order the
  ``/memory`` command displays. Written by the Node ``/memory`` handler into the
  shared ``settings.db`` (CONTRACT §8); read here for the per-turn long-term
  memory block injected into LLM2.

  Cached per ``(tenant, chat_id)``; the cache is cleared wholesale by
  :func:`bridge.db.core.reset_settings_connection` on any settings
  invalidation (a global-memory change affects every chat's effective list).
  """
  if not chat_id:
    return []
  with _cache_lock:
    cached = _memory_cache.get(_tenant_cache_key(chat_id), _MISSING)
  if cached is not _MISSING:
    return list(cached)  # type: ignore[arg-type]
  _ensure_split_ready()
  conn = _get_settings_conn()
  rows = conn.execute(
    """
    SELECT text FROM memories
    WHERE scope_key IN (?, ?)
    ORDER BY (scope_key = ?) ASC, id ASC
    """,
    (GLOBAL_CHAT_ID, chat_id, chat_id),
  ).fetchall()
  values = [row['text'] for row in rows]
  with _cache_lock:
    _memory_cache[_tenant_cache_key(chat_id)] = list(values)
  return values

@_db_resilient('settings')
def get_participant_name(chat_id: str, sender_ref: str) -> Optional[str]:
  """Return the CURRENT display name for *sender_ref* in *chat_id*, or None.

  Backs the live re-rendering of ``@Name (senderRef)`` mention tokens in stored
  /memory & /prompt text. The Node gateway keeps this roster fresh (it UPSERTs
  the sender's latest pushName on every inbound message), so a name that was
  unknown when a memory was saved — the bot baked the bare LID number then —
  resolves once that person has spoken, and a rename tracks automatically.

  No caching: the lookup is tiny and freshness matters for renames. The table is
  owned/created by Node (settings.db); tolerate it being absent (return None) so
  a bridge that connects before the gateway has created it never crashes.
  """
  if not chat_id or not sender_ref:
    return None
  _ensure_split_ready()
  conn = _get_settings_conn()
  try:
    row = conn.execute(
      'SELECT name FROM participant_names WHERE chat_id = ? AND sender_ref = ?',
      (chat_id, sender_ref),
    ).fetchone()
  except Exception:
    return None  # table not created yet (Node owns the settings.db schema)
  return row['name'] if row is not None and row['name'] else None

@_db_resilient('settings')
def get_permission(chat_id: str) -> int:
  """Return the permission level (0-3) for *chat_id*. Default ``0``."""
  with _cache_lock:
    cached = _permission_cache.get(_tenant_cache_key(chat_id), _MISSING)
  if cached is not _MISSING:
    return cached  # type: ignore[return-value]

  row = _get_setting_row(chat_id)
  value = int(row['permission']) if row is not None else 0
  with _cache_lock:
    _permission_cache[_tenant_cache_key(chat_id)] = value
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
    _permission_cache[_tenant_cache_key(chat_id)] = clamped
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
      _prompt_cache.pop(_tenant_cache_key(chat_id), None)
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

@_db_resilient('settings')
def get_mode(chat_id: str) -> str:
  """Return the chat mode ('auto', 'prefix', or 'hybrid'). Default 'prefix'."""
  with _cache_lock:
    cached = _mode_cache.get(_tenant_cache_key(chat_id), _MISSING)
  if cached is not _MISSING:
    return cached  # type: ignore[return-value]

  row = _get_setting_row(chat_id)
  value = row['mode'] if row is not None else DEFAULT_MODE
  if value not in VALID_MODES:
    value = DEFAULT_MODE
  with _cache_lock:
    _mode_cache[_tenant_cache_key(chat_id)] = value
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
    _mode_cache[_tenant_cache_key(chat_id)] = mode
  logger.info('DB set_mode chat_id=%s mode=%s', chat_id, mode)

@_db_resilient('settings')
def get_triggers(chat_id: str) -> set[str]:
  """Return the set of enabled trigger types for *chat_id*."""
  with _cache_lock:
    cached = _triggers_cache.get(_tenant_cache_key(chat_id), _MISSING)
  if cached is not _MISSING:
    raw = cached  # type: ignore[assignment]
  else:
    row = _get_setting_row(chat_id)
    raw = row['triggers'] if row is not None else DEFAULT_TRIGGERS
    with _cache_lock:
      _triggers_cache[_tenant_cache_key(chat_id)] = raw
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
    _triggers_cache[_tenant_cache_key(chat_id)] = raw
  logger.info('DB set_triggers chat_id=%s triggers=%s', chat_id, raw)

@_db_resilient('settings')
def get_subagent_enabled(chat_id: str) -> bool:
  """Return whether subagent is enabled for *chat_id*. Default False."""
  with _cache_lock:
    cached = _subagent_enabled_cache.get(_tenant_cache_key(chat_id), _MISSING)
  if cached is not _MISSING:
    return cached  # type: ignore[return-value]

  row = _get_setting_row(chat_id)
  value = bool(row['subagent_enabled']) if row is not None else DEFAULT_SUBAGENT_ENABLED
  with _cache_lock:
    _subagent_enabled_cache[_tenant_cache_key(chat_id)] = value
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
    _subagent_enabled_cache[_tenant_cache_key(chat_id)] = enabled
  logger.info('DB set_subagent_enabled chat_id=%s enabled=%s', chat_id, enabled)

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
