"""``ScheduledTaskRunner`` — feature 5 one-shot scheduled-task execution.

Persists ``/schedule-task`` rows (via an injected
:class:`~bridge.db.scheduled_tasks_repository.ScheduledTasksRepository`), arms an
``asyncio`` timer per task, and on fire RE-INVOKES LLM2 in the target chat —
exactly like a finished sub-agent (:func:`bridge.agent.subagent_coordinator._deliver_subagent_result`):
it appends a ``[SCHEDULED TASK]`` system message to the chat history deque, calls
``responder.generate(...)`` (always responding — no LLM1 gating), and dispatches
the resulting actions through the gateway ``send_*`` helpers.

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

from ..history import (
  WhatsAppMessage,
  assistant_name,
  assistant_sender_ref,
  hydrate_quoted_from_history,
)
from ..log import setup_logging
from ..stickers import resolve_sticker
from ..messaging.processing import (
  _append_history,
  _collect_context_ids,
  _make_request_id,
  _normalize_context_msg_id,
  _normalize_preview_text,
  extract_first_code_block,
)
from ..messaging.actions import (
  _extract_actions,
  _extract_actions_from_tool_calls,
)
from ..messaging.gateway import (
  _dispatch_sticker,
  send_copy_code,
  send_delete_message,
  send_kick_member,
  send_message,
  send_react_message,
  typing_indicator,
)

logger = setup_logging()


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
  ) -> None:
    self._repository = repository
    self._ws = ws
    self._responder = responder
    self._per_chat = per_chat
    self._per_chat_lock = per_chat_lock
    self._track_task = track_task
    self._get_prompt = get_prompt
    self._record_stat = record_stat

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
      await self._execute(task)
    except asyncio.CancelledError:
      raise
    except Exception as err:  # pylint: disable=broad-except
      logger.exception("scheduled task fire failed id=%s: %s", task.id, err)
    # Delete AFTER firing (success or hard-fail). Not reached on cancellation.
    try:
      self._repository.delete(task.id)
    except Exception as err:  # pylint: disable=broad-except
      logger.warning("scheduled task delete failed id=%s: %s", task.id, err)

  async def _execute(self, task) -> None:
    chat_id = task.chat_id
    lock = self._per_chat_lock[chat_id]
    async with lock:
      history = self._per_chat[chat_id]
      scheduled_text = f"[SCHEDULED TASK]\n{task.prompt}"
      # Append the scheduled instruction to history as a system turn so the
      # model sees it as the latest context (mirrors [SUBTASK FINISHED]).
      history.append(WhatsAppMessage(
        timestamp_ms=int(time.time() * 1000),
        sender="system",
        text=scheduled_text,
        role="system",
      ))

      # Reconstruct a MINIMAL context for this cold (timer) fire.
      chat_type = "group" if chat_id.endswith("@g.us") else "private"
      db_prompt = None
      if self._get_prompt is not None:
        try:
          db_prompt = self._get_prompt(chat_id)
        except Exception:  # pylint: disable=broad-except
          db_prompt = None
      group_description = None
      bot_is_admin = False
      bot_is_super_admin = False

      current = WhatsAppMessage(
        timestamp_ms=int(time.time() * 1000),
        sender="system",
        context_msg_id="system",
        sender_ref=assistant_sender_ref(),
        text=scheduled_text,
        role="system",
      )
      scheduled_task_block = (
        "## Scheduled task firing now\n"
        f"{scheduled_text}\n\n"
        "Instructions for this re-invoke:\n"
        "- A previously scheduled task is firing NOW. Carry it out and respond "
        "in this chat.\n"
        "- Send the appropriate reply_message (and/or tools) to fulfil the "
        "task in the chat's language and WhatsApp formatting.\n"
        "- If the task names someone to remind/tag, use the "
        "`@Name (senderRef)` mention format so they get tagged.\n"
        "- Do not ask for confirmation — just perform the task."
      )

      allowed_context_ids = _collect_context_ids(history)
      fallback_reply_to = None
      reinvoke_history = list(history)
      reply_msg = None
      try:
        async with typing_indicator(self._ws, chat_id):
          reply_msg = await self._responder.generate(
            reinvoke_history,
            current,
            current_payload={"chatId": chat_id, "chatType": chat_type},
            group_description=group_description,
            prompt_override=db_prompt,
            chat_type=chat_type,
            bot_is_admin=bot_is_admin,
            bot_is_super_admin=bot_is_super_admin,
            allow_subagent=False,
            scheduled_task_block=scheduled_task_block,
          )
      except Exception as gen_err:  # pylint: disable=broad-except
        logger.exception(
          "scheduled task: LLM2 re-invoke failed id=%s: %s", task.id, gen_err,
          extra={"chat_id": chat_id},
        )
        reply_msg = None

      if reply_msg is None:
        logger.warning(
          "scheduled task: LLM2 produced no reply id=%s",
          task.id, extra={"chat_id": chat_id},
        )
        return

      tool_calls = getattr(reply_msg, "tool_calls", None) or []
      if tool_calls:
        actions = _extract_actions_from_tool_calls(
          tool_calls,
          fallback_reply_to=fallback_reply_to,
          allowed_context_ids=allowed_context_ids,
        )
      else:
        actions = _extract_actions(
          reply_msg,
          fallback_reply_to=fallback_reply_to,
          allowed_context_ids=allowed_context_ids,
        )

      await self._dispatch_actions(chat_id, history, actions)

  async def _dispatch_actions(self, chat_id: str, history, actions: list) -> None:
    """Dispatch the LLM2 actions from a scheduled fire (subset mirror of the
    sub-agent re-invoke dispatch)."""
    for action in actions:
      action_type = action.get("type")
      if action_type == "send_message":
        text = action.get("text") or ""
        request_id = _make_request_id("send")
        await send_message(
          self._ws, chat_id, text, action.get("replyTo"), request_id=request_id,
        )
        if self._record_stat is not None:
          self._record_stat(chat_id, "responses_sent")
        _prov = WhatsAppMessage(
          timestamp_ms=int(time.time() * 1000),
          sender=assistant_name(),
          context_msg_id="pending",
          sender_ref=assistant_sender_ref(),
          sender_is_admin=False,
          text=text or None,
          media=None,
          quoted_message_id=_normalize_context_msg_id(action.get("replyTo")),
          quoted_sender=None,
          quoted_text=None,
          quoted_media=None,
          quoted_sender_ref=None,
          quoted_sender_is_admin=False,
          quoted_sender_is_super_admin=False,
          message_id=f"local-send-{request_id}",
          role="assistant",
        )
        hydrate_quoted_from_history(_prov, history)
        _append_history(history, _prov)
        _code = extract_first_code_block(text)
        if _code:
          await send_copy_code(
            self._ws, chat_id, _code,
            quoted_preview_text=_normalize_preview_text(_code, limit=120),
            request_id=_make_request_id("copy"),
          )
      elif action_type == "react_message":
        await send_react_message(
          self._ws, chat_id,
          action.get("contextMsgId"), action.get("emoji"),
          request_id=_make_request_id("react"),
        )
      elif action_type in ("express_message", "send_sticker"):
        expression = str(
          action.get("expression") or action.get("stickerName") or ""
        ).strip()
        target = action.get("contextMsgId") or action.get("replyTo")
        if not expression:
          continue
        sticker_info = resolve_sticker(expression, chat_id=chat_id)
        if sticker_info:
          await _dispatch_sticker(
            self._ws, chat_id, sticker_info, target,
            request_id=_make_request_id("sticker"),
          )
          if self._record_stat is not None:
            self._record_stat(chat_id, "stickers_sent")
        elif action_type == "express_message":
          await send_react_message(
            self._ws, chat_id, action.get("contextMsgId"), expression,
            request_id=_make_request_id("react"),
          )
      elif action_type == "delete_message":
        await send_delete_message(
          self._ws, chat_id, action.get("contextMsgId"),
          request_id=_make_request_id("delete"),
        )
      elif action_type == "kick_member":
        await send_kick_member(
          self._ws, chat_id, action.get("targets") or [],
          request_id=_make_request_id("kick"),
          mode=action.get("mode") or "partial_success",
        )
      else:
        logger.debug(
          "scheduled task: ignoring unsupported action type=%s", action_type,
          extra={"chat_id": chat_id},
        )
