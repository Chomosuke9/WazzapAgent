"""Persistent recurring ``/daily-task`` scheduler and LLM2 re-invoker."""
from __future__ import annotations

import asyncio
import time
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

from .. import config
from ..log import setup_logging
from .chat_reinvoker import ChatReinvoker

logger = setup_logging()

_DAILY_BLOCK_TITLE = "Daily task firing now"
_DAILY_BLOCK_INSTRUCTIONS = (
  "Instructions for this re-invoke:\n"
  "- A recurring daily task is firing NOW. Carry it out and respond in this chat.\n"
  "- Send the appropriate reply_message (and/or commands/tools) to fulfil it.\n"
  "- Preserve `@Name (senderRef)` mentions so the intended people are tagged.\n"
  "- Do not ask for confirmation; perform the task now."
)


def _configured_timezone(raw: str | None = None):
  value = config.context_time_utc_offset_raw() if raw is None else raw
  try:
    hours = float(value) if value is not None and str(value).strip() else None
  except (TypeError, ValueError):
    hours = None
  if hours is not None and -24 <= hours <= 24:
    return timezone(timedelta(hours=hours))
  return datetime.now().astimezone().tzinfo or timezone.utc


def next_daily_fire_at_ms(
  time_of_day: str,
  *,
  now_ms: int | None = None,
  utc_offset_raw: str | None = None,
) -> int:
  """Return the next occurrence of ``HH:MM`` in the configured context zone."""
  hour_text, minute_text = time_of_day.split(":", 1)
  hour, minute = int(hour_text), int(minute_text)
  if not (0 <= hour <= 23 and 0 <= minute <= 59):
    raise ValueError("invalid daily time")
  tz = _configured_timezone(utc_offset_raw)
  now = datetime.fromtimestamp((now_ms if now_ms is not None else int(time.time() * 1000)) / 1000, tz)
  candidate = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
  if candidate <= now:
    candidate += timedelta(days=1)
  return int(candidate.timestamp() * 1000)


class DailyTaskRunner:
  def __init__(
    self,
    *,
    repository,
    ws,
    responder,
    per_chat,
    per_chat_lock,
    track_task: Callable[[asyncio.Task], None],
    get_prompt: Optional[Callable[[str], Optional[str]]] = None,
    record_stat: Optional[Callable[..., None]] = None,
    reinvoker: Optional[ChatReinvoker] = None,
  ) -> None:
    self._repository = repository
    self._track_task = track_task
    self._timers: dict[str, asyncio.Task] = {}
    self._reinvoker = reinvoker or ChatReinvoker(
      ws=ws,
      responder=responder,
      per_chat=per_chat,
      per_chat_lock=per_chat_lock,
      get_prompt=get_prompt,
      record_stat=record_stat,
    )

  async def schedule(self, frame: dict) -> None:
    chat_id = frame.get("chatId")
    task_id = frame.get("taskId")
    time_of_day = str(frame.get("timeOfDay") or "")
    prompt = frame.get("prompt") or ""
    try:
      next_daily_fire_at_ms(time_of_day)
    except (TypeError, ValueError):
      logger.warning("daily_task: dropping malformed time frame=%s", frame)
      return
    if not chat_id or not task_id or not prompt:
      logger.warning("daily_task: dropping malformed frame=%s", frame)
      return
    from ..db import DailyTask
    task = DailyTask(
      id=task_id,
      chat_id=chat_id,
      time_of_day=time_of_day,
      prompt=prompt,
      created_at_ms=int(time.time() * 1000),
    )
    try:
      self._repository.add(task)
    except Exception as err:  # pylint: disable=broad-except
      logger.exception("daily_task: failed to persist id=%s: %s", task_id, err)
      return
    logger.info(
      "daily_task: scheduled id=%s chat_id=%s time_of_day=%s",
      task_id, chat_id, time_of_day,
    )
    self._arm(task)

  def rearm_pending(self) -> None:
    try:
      tasks = self._repository.list_all()
    except Exception as err:  # pylint: disable=broad-except
      logger.exception("daily_task rearm: failed to load tasks: %s", err)
      return
    for task in tasks:
      self._arm(task)
    if tasks:
      logger.info("daily_task: re-armed %d task(s)", len(tasks))

  def list_for_chat(self, chat_id: str):
    """Return only this chat's recurring tasks, in repository order."""
    return [task for task in self._repository.list_all() if task.chat_id == chat_id]

  def delete_for_chat(self, chat_id: str, task_id: str):
    """Cancel and delete one task addressed by its full ID or list prefix.

    IDs are resolved inside the originating chat. This keeps a UUID learned in
    one chat from deleting a task owned by another chat in the same tenant.
    """
    token = str(task_id or "").strip()
    tasks = self.list_for_chat(chat_id)
    exact = [task for task in tasks if task.id == token]
    if exact:
      matches = exact
    elif len(token) < 8:
      return "invalid", None
    else:
      folded = token.lower()
      matches = [task for task in tasks if task.id.lower().startswith(folded)]
    if not matches:
      return "not_found", None
    if len(matches) > 1:
      return "ambiguous", None

    task = matches[0]
    # Persist the deletion before cancelling its in-memory timer. If SQLite is
    # temporarily unavailable, the existing timer keeps running rather than
    # silently leaving a durable task unscheduled until the next restart.
    self._repository.delete(task.id)
    timer = self._timers.pop(task.id, None)
    if timer and timer is not asyncio.current_task() and not timer.done():
      timer.cancel()
    logger.info("daily_task: deleted id=%s chat_id=%s", task.id, chat_id)
    return "deleted", task

  def _arm(self, task) -> asyncio.Task:
    previous = self._timers.get(task.id)
    if previous and previous is not asyncio.current_task() and not previous.done():
      previous.cancel()

    async def _timer(task=task) -> None:
      try:
        fire_at_ms = next_daily_fire_at_ms(task.time_of_day)
        delay_s = max(0.0, (fire_at_ms - int(time.time() * 1000)) / 1000.0)
        if delay_s > 0:
          await asyncio.sleep(delay_s)
        await self._fire(task)
      except asyncio.CancelledError:
        raise
      except Exception as err:  # pylint: disable=broad-except
        logger.exception("daily task timer error id=%s: %s", task.id, err)
      finally:
        if self._timers.get(task.id) is asyncio.current_task():
          self._timers.pop(task.id, None)
      # The row remains persisted; arm the next day's occurrence after every
      # success or hard failure. Cancellation exits before this line.
      self._arm(task)

    timer = asyncio.create_task(_timer())
    self._timers[task.id] = timer
    self._track_task(timer)
    return timer

  async def _fire(self, task) -> None:
    await self._reinvoker.reinvoke(
      task.chat_id,
      task.prompt,
      system_label="DAILY TASK",
      block_title=_DAILY_BLOCK_TITLE,
      block_instructions=_DAILY_BLOCK_INSTRUCTIONS,
      log_kind="daily task",
    )
