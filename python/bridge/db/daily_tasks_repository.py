"""Tenant-scoped persistence for recurring ``/daily-task`` entries."""
from __future__ import annotations

from dataclasses import dataclass
from typing import List

from .core import _db_resilient, _ensure_split_ready, _get_settings_conn, logger


@dataclass
class DailyTask:
  id: str
  chat_id: str
  time_of_day: str
  prompt: str
  created_at_ms: int


@_db_resilient("settings")
def add_daily_task(task: DailyTask) -> None:
  _ensure_split_ready()
  conn = _get_settings_conn()
  conn.execute(
    """
    INSERT OR REPLACE INTO daily_tasks
      (id, chat_id, time_of_day, prompt, created_at_ms)
    VALUES (?, ?, ?, ?, ?)
    """,
    (task.id, task.chat_id, task.time_of_day, task.prompt, int(task.created_at_ms)),
  )
  conn.commit()
  logger.info(
    "DB add_daily_task id=%s chat_id=%s time_of_day=%s",
    task.id, task.chat_id, task.time_of_day,
  )


@_db_resilient("settings")
def list_daily_tasks() -> List[DailyTask]:
  _ensure_split_ready()
  conn = _get_settings_conn()
  rows = conn.execute(
    """
    SELECT id, chat_id, time_of_day, prompt, created_at_ms
    FROM daily_tasks
    ORDER BY time_of_day ASC, created_at_ms ASC
    """
  ).fetchall()
  return [
    DailyTask(
      id=row["id"],
      chat_id=row["chat_id"],
      time_of_day=row["time_of_day"],
      prompt=row["prompt"],
      created_at_ms=int(row["created_at_ms"]),
    )
    for row in rows
  ]


@_db_resilient("settings")
def delete_daily_task(task_id: str) -> None:
  _ensure_split_ready()
  conn = _get_settings_conn()
  conn.execute("DELETE FROM daily_tasks WHERE id = ?", (task_id,))
  conn.commit()
  logger.info("DB delete_daily_task id=%s", task_id)


class DailyTasksRepository:
  def add(self, task: DailyTask) -> None:
    add_daily_task(task)

  def list_all(self) -> List[DailyTask]:
    return list_daily_tasks()

  def delete(self, task_id: str) -> None:
    delete_daily_task(task_id)
