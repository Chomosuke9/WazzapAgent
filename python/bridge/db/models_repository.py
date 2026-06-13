"""LLM2 model repository (default/per-chat model resolution, vision support,
model catalog CRUD) — split out of ``bridge/db.py`` (Step 11).

All functions, SQL and signatures are unchanged. The default-model cache
(``_default_llm2_model_cache``) is a *reassignable* module scalar shared with
the core recovery/invalidation paths, so it is referenced through
:mod:`bridge.db.core` to keep a single canonical binding across the split.
"""
from __future__ import annotations

import sqlite3
from typing import Optional

from . import core
from .core import (
    logger,
    _db_resilient,
    _cache_lock,
    _MISSING,
    _llm2_model_cache,
    _tenant_cache_key,
    _tenant_key,
    _ensure_split_ready,
    _get_settings_conn,
    _get_setting_row,
    _ensure_chat_row,
    _pop_all_chat_caches,
)


@_db_resilient('settings')
def get_default_llm2_model() -> Optional[dict]:
  """Return the default model (lowest sort_order, is_active=1)."""
  tkey = _tenant_key()
  cached = core._default_llm2_model_cache.get(tkey)
  if cached is not None:
    return cached
  _ensure_split_ready()
  conn = _get_settings_conn()
  row = conn.execute(
    'SELECT model_id, display_name, description, vision_support FROM llm_models WHERE is_active = 1 ORDER BY sort_order ASC LIMIT 1'
  ).fetchone()
  if row:
    core._default_llm2_model_cache[tkey] = {
      'model_id': row['model_id'],
      'display_name': row['display_name'],
      'description': row['description'],
      'vision_support': bool(row['vision_support']),
    }
    return core._default_llm2_model_cache[tkey]
  return None

@_db_resilient('settings')
def get_llm2_model(chat_id: str) -> Optional[str]:
  """Return the model_id for chat_id, or None if not set."""
  key = _tenant_cache_key(chat_id)
  with _cache_lock:
    cached = _llm2_model_cache.get(key, _MISSING)
  if cached is not _MISSING:
    return cached if cached is not None else None

  row = _get_setting_row(chat_id)
  value = row['llm2_model'] if row is not None else None
  with _cache_lock:
    _llm2_model_cache[key] = value
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
    _llm2_model_cache[_tenant_cache_key(chat_id)] = model_id
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

@_db_resilient('settings')
def add_model(model_id: str, display_name: str, description: str = '', sort_order: Optional[int] = None, vision_support: bool = False) -> bool:
  """Add a new model. Returns False if model_id already exists."""
  core._default_llm2_model_cache.pop(core._tenant_key(), None)
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
  core._default_llm2_model_cache.pop(core._tenant_key(), None)
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
  core._default_llm2_model_cache.pop(core._tenant_key(), None)
  _ensure_split_ready()
  conn = _get_settings_conn()
  existing = conn.execute('SELECT model_id FROM llm_models WHERE model_id = ?', (model_id,)).fetchone()
  if not existing:
    return False
  affected_rows = conn.execute('SELECT chat_id FROM chat_settings WHERE llm2_model = ?', (model_id,)).fetchall()
  with _cache_lock:
    for row in affected_rows:
      _llm2_model_cache.pop(_tenant_cache_key(row['chat_id']), None)
  conn.execute('DELETE FROM llm_models WHERE model_id = ?', (model_id,))
  conn.execute('UPDATE chat_settings SET llm2_model = NULL WHERE llm2_model = ?', (model_id,))
  conn.commit()
  logger.info('DB delete_model model_id=%s', model_id)
  return True
