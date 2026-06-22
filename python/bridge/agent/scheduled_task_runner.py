"""``ScheduledTaskRunner`` — feature 5 one-shot scheduled-task execution.

Persists ``/schedule-task`` rows (via an injected
:class:`~bridge.db.scheduled_tasks_repository.ScheduledTasksRepository`), arms an
``asyncio`` timer per task, and on fire RE-INVOKES LLM2 in the target chat —
exactly like a finished sub-agent (:func:`bridge.agent.subagent_coordinator._deliver_subagent_result`):
it appends a ``[SCHEDULED TASK]`` system message to the chat history deque, calls
``responder.generate(...)`` (always responding — no LLM1 gating), and dispatches
the resulting actions through the gateway ``send_*`` helpers.

The re-invoke + dispatch machinery itself lives in the shared
:class:`~bridge.agent.chat_reinvoker.ChatReinvoker` (also used by the
direct-invoke HTTP endpoint); this runner owns ONLY the scheduling concern
(persist / arm timers / one-shot fire) and delegates the actual LLM2 re-invoke
to it with the scheduled-task label + instruction block.

Scheduled tasks survive a gateway/bridge restart: rows are persisted, and
:meth:`rearm_pending` re-arms every stored row on session start (firing
immediately for any already past due). Each fire is ONE-SHOT — the row is
deleted after firing (success or hard-fail) so a bad task can't loop forever.
A task cancelled during shutdown is NOT deleted, so it re-arms on the next boot.

Dependencies are injected explicitly (repository / ws / responder / per-chat
history+lock / track_task / get_prompt) so the runner is unit-testable with
fakes — no live socket or DB required.
"""
from __future__ import annotations

import asyncio
import time
from typing import Callable, Optional

from ..log import setup_logging
from .chat_reinvoker import ChatReinvoker

logger = setup_logging()


# Scheduled-task re-invoke instruction block (the slot LLM2 sees right before
# the message window). Kept module-level so the wording is stable + greppable.
_SCHEDULED_BLOCK_TITLE = "Scheduled task firing now"
_SCHEDULED_BLOCK_INSTRUCTIONS = (
  "Instructions for this re-invoke:\n"
  "- A previously scheduled task is firing NOW. Carry it out and respond "
  "in this chat.\n"
  "- Send the appropriate reply_message (and/or tools) to fulfil the "
  "task in the chat's language and WhatsApp formatting.\n"
  "- If the task names someone to remind/tag, use the "
  "`@Name (senderRef)` mention format so they get tagged.\n"
  "- Do not ask for confirmation — just perform the task."
)


class ScheduledTaskRunner:
  """Per-account scheduled-task scheduler + cold-fire executor (feature 5)."""

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
    # The shared re-invoke engine. A caller (the session) may inject ONE shared
    # instance so the scheduled-task and direct-invoke paths reuse it; if not
    # provided we build our own from the same deps (keeps the legacy
    # constructor signature working for existing unit tests).
    self._reinvoker = reinvoker or ChatReinvoker(
      ws=ws,
      responder=responder,
      per_chat=per_chat,
      per_chat_lock=per_chat_lock,
      get_prompt=get_prompt,
      record_stat=record_stat,
    )

  # ------------------------------------------------------------------ #
  # Public API
  # ------------------------------------------------------------------ #

  async def schedule(self, frame: dict) -> None:
    """Persist a ``schedule_task`` control frame then arm its timer.

    ``frame`` is the §1.5 top-level dict surfaced by the SDK (camelCase keys:
    ``chatId`` / ``taskId`` / ``fireAtMs`` / ``prompt``).
    """
    chat_id = frame.get("chatId")
    task_id = frame.get("taskId")
    prompt = frame.get("prompt") or ""
    try:
      fire_at_ms = int(frame.get("fireAtMs"))
    except (TypeError, ValueError):
      fire_at_ms = 0
    if not chat_id or not task_id or not prompt:
      logger.warning("schedule_task: dropping malformed frame=%s", frame)
      return
    from ..db import ScheduledTask  # local import: keeps module import light
    task = ScheduledTask(
      id=task_id,
      chat_id=chat_id,
      fire_at_ms=fire_at_ms,
      prompt=prompt,
      created_at_ms=int(time.time() * 1000),
    )
    try:
      self._repository.add(task)
    except Exception as err:  # pylint: disable=broad-except
      logger.exception("schedule_task: failed to persist id=%s: %s", task_id, err)
      return
    logger.info(
      "schedule_task: scheduled id=%s chat_id=%s fire_at_ms=%s",
      task_id, chat_id, fire_at_ms,
    )
    self._arm(task)

  def rearm_pending(self) -> None:
    """Re-arm every persisted scheduled task (called once on session start).

    Tasks already past due fire ASAP (their computed delay clamps to 0).
    """
    try:
      tasks = self._repository.list_all()
    except Exception as err:  # pylint: disable=broad-except
      logger.exception("rearm_pending: failed to load scheduled tasks: %s", err)
      return
    for task in tasks:
      self._arm(task)
    if tasks:
      logger.info("rearm_pending: re-armed %d scheduled task(s)", len(tasks))

  # ------------------------------------------------------------------ #
  # Internal
  # ------------------------------------------------------------------ #

  def _arm(self, task) -> asyncio.Task:
    """Spawn a background timer that sleeps until ``fire_at_ms`` then fires."""

    async def _timer(task=task) -> None:
      try:
        delay_s = max(0.0, (task.fire_at_ms - int(time.time() * 1000)) / 1000.0)
        if delay_s > 0:
          await asyncio.sleep(delay_s)
        await self._fire(task)
      except asyncio.CancelledError:
        raise
      except Exception as err:  # pylint: disable=broad-except
        # One bad task must never kill other timers / the event loop.
        logger.exception("scheduled task timer error id=%s: %s", task.id, err)

    timer_task = asyncio.create_task(_timer())
    self._track_task(timer_task)
    return timer_task

  async def _fire(self, task) -> None:
    """Execute one scheduled task, then delete its row (one-shot).

    A ``CancelledError`` (shutdown) is re-raised WITHOUT deleting the row so the
    task re-arms on the next boot. Any other exception is swallowed and the row
    is still deleted to avoid an infinite retry loop.
    """
    try:
      await self._reinvoker.reinvoke(
        task.chat_id,
        task.prompt,
        system_label="SCHEDULED TASK",
        block_title=_SCHEDULED_BLOCK_TITLE,
        block_instructions=_SCHEDULED_BLOCK_INSTRUCTIONS,
        log_kind="scheduled task",
      )
    except asyncio.CancelledError:
      raise
    except Exception as err:  # pylint: disable=broad-except
      logger.exception("scheduled task fire failed id=%s: %s", task.id, err)
    # Delete AFTER firing (success or hard-fail). Not reached on cancellation.
    try:
      self._repository.delete(task.id)
    except Exception as err:  # pylint: disable=broad-except
      logger.warning("scheduled task delete failed id=%s: %s", task.id, err)
