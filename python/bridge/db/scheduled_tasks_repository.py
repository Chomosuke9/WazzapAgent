"""Scheduled-task repository (feature 5) — persists one-shot `/schedule-task`
rows in the per-tenant ``settings.db``.

Mirrors the other per-domain repositories (see
:mod:`bridge.db.settings_repository`): module-level CRUD helpers wrapped with
``@_db_resilient('settings')`` over the shared connection from
:mod:`bridge.db.core`, plus a thin :class:`ScheduledTasksRepository` class
exposing ``add`` / ``list_all`` / ``delete`` for the
:class:`~bridge.agent.scheduled_task_runner.ScheduledTaskRunner` to depend on.

The ``scheduled_tasks`` table itself is created (``CREATE TABLE IF NOT EXISTS``)
by :func:`bridge.db.core._ensure_settings_tables`, so it is shared with the Node
gateway's per-tenant ``settings.db`` file (CONTRACT.md §8) without a second
schema definition.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List

from .core import (
    logger,
    _db_resilient,
    _ensure_split_ready,
    _get_settings_conn,
)


@dataclass
class ScheduledTask:
  """One persisted scheduled task row."""
  id: str
  chat_id: str
  fire_at_ms: int
  prompt: str
  created_at_ms: int


@_db_resilient('settings')
def add_scheduled_task(task: ScheduledTask) -> None:
  """Insert (or replace by id) a scheduled task row."""
  _ensure_split_ready()
  conn = _get_settings_conn()
  conn.execute(
    """
    INSERT OR REPLACE INTO scheduled_tasks
      (id, chat_id, fire_at_ms, prompt, created_at_ms)
    VALUES (?, ?, ?, ?, ?)
    """,
    (task.id, task.chat_id, int(task.fire_at_ms), task.prompt, int(task.created_at_ms)),
  )
  conn.commit()
  logger.info(
    'DB add_scheduled_task id=%s chat_id=%s fire_at_ms=%s',
    task.id, task.chat_id, task.fire_at_ms,
  )


@_db_resilient('settings')
def list_scheduled_tasks() -> List[ScheduledTask]:
  """Return all persisted scheduled tasks, soonest-firing first."""
  _ensure_split_ready()
  conn = _get_settings_conn()
  rows = conn.execute(
    """
    SELECT id, chat_id, fire_at_ms, prompt, created_at_ms
    FROM scheduled_tasks
    ORDER BY fire_at_ms ASC
    """
  ).fetchall()
  return [
    ScheduledTask(
      id=row['id'],
      chat_id=row['chat_id'],
      fire_at_ms=int(row['fire_at_ms']),
      prompt=row['prompt'],
      created_at_ms=int(row['created_at_ms']),
    )
    for row in rows
  ]


@_db_resilient('settings')
def delete_scheduled_task(task_id: str) -> None:
  """Delete a scheduled task row by id (no-op if it does not exist)."""
  _ensure_split_ready()
  conn = _get_settings_conn()
  conn.execute('DELETE FROM scheduled_tasks WHERE id = ?', (task_id,))
  conn.commit()
  logger.info('DB delete_scheduled_task id=%s', task_id)


class ScheduledTasksRepository:
  """Per-tenant scheduled-task store (feature 5).

  Thin object wrapper over the module-level CRUD helpers so collaborators can
  depend on an injected repository instance (and tests can swap a fake). All
  routing/resilience lives in :mod:`bridge.db.core`; methods resolve the active
  tenant's ``settings.db`` via the ``_tenant_db_dir`` ContextVar.
  """

  def add(self, task: ScheduledTask) -> None:
    add_scheduled_task(task)

  def list_all(self) -> List[ScheduledTask]:
    return list_scheduled_tasks()

  def delete(self, task_id: str) -> None:
    delete_scheduled_task(task_id)
