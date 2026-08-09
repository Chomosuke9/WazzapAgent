"""``ChatReinvoker`` — shared "inject a ``#system`` turn + re-invoke LLM2 +
dispatch the reply" engine.

This is the cold-fire machinery that used to live inline in
:class:`~bridge.agent.scheduled_task_runner.ScheduledTaskRunner`. It is the
exact path a finished sub-agent takes
(:func:`bridge.agent.subagent_coordinator._deliver_subagent_result`): append a
system turn to the chat history deque, call ``responder.generate(...)`` (ALWAYS
responding — no LLM1 gating), then dispatch the resulting actions through the
gateway ``send_*`` helpers.

Cold/system callers share it:

  - :class:`ScheduledTaskRunner` — a ``/schedule-task`` timer fires.
  - :class:`~bridge.agent.daily_task_runner.DailyTaskRunner` — recurring fire.
  - :class:`~bridge.agent.direct_invoke.DirectInvokeServer` — an authenticated
    HTTP ``/post`` request asks the bot to send a message first.

They differ only in the label shown in history and the re-invoke instruction
block. Everything else (history append, canonical live context build, LLM2
call, action extraction + dispatch) is identical.

Dependencies are injected explicitly (ws / responder / per-chat history+lock /
get_prompt / record_stat) so the engine is unit-testable with fakes — no live
socket or DB required.
"""
from __future__ import annotations

import time
from collections import OrderedDict
from typing import Callable, Optional

from ..history import (
  WhatsAppMessage,
  assistant_name,
  assistant_sender_ref,
  hydrate_quoted_from_history,
)
from ..log import setup_logging
from ..llm.prompt import render_stored_mentions
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
from .llm_context_builder import LlmContextBuilder
from .llm_action_dispatcher import dispatch_llm_run_command

logger = setup_logging()


class ChatReinvoker:
  """Re-invoke LLM2 in a chat with an injected ``#system`` instruction turn.

  :param ws: the live ``WaSocket`` (gateway) the dispatched actions go over.
  :param responder: an object exposing ``async generate(history, current, **kw)``
    (the per-account :class:`~bridge.agent.llm2_responder.Llm2Responder`).
  :param per_chat: per-chat history deques (shared with the session).
  :param per_chat_lock: per-chat ``asyncio.Lock`` map (shared with the session).
  :param get_prompt: optional ``chat_id -> system-prompt-override`` lookup.
  :param record_stat: optional ``(chat_id, key)`` dashboard stat recorder.
  :param pending_send_request_chat: optional account-shared ``request_id ->
    chat_id`` map (an ``OrderedDict`` used as an LRU). When provided, each
    dispatched ``send_message`` is registered here so the ``action_ack``
    hydrator can upgrade the provisional ``context_msg_id="pending"`` history
    entry to its real 6-digit id — exactly like the normal message path and the
    sub-agent task-complete path. When ``None`` (legacy / unit tests) the send
    is still appended to history but stays provisional.
  """

  def __init__(
    self,
    *,
    ws,
    responder,
    per_chat,
    per_chat_lock,
    get_prompt: Optional[Callable[[str], Optional[str]]] = None,
    record_stat: Optional[Callable[..., None]] = None,
    pending_send_request_chat: Optional[OrderedDict] = None,
    pending_run_command_chat: Optional[OrderedDict] = None,
    context_builder: Optional[LlmContextBuilder] = None,
  ) -> None:
    self._ws = ws
    self._responder = responder
    self._per_chat = per_chat
    self._per_chat_lock = per_chat_lock
    self._record_stat = record_stat
    self._pending_send_request_chat = pending_send_request_chat
    self._pending_run_command_chat = pending_run_command_chat
    self._context_builder = context_builder or LlmContextBuilder(
      ws=ws,
      get_prompt=get_prompt,
    )

  async def reinvoke(
    self,
    chat_id: str,
    prompt: str,
    *,
    system_label: str,
    block_title: str,
    block_instructions: str,
    log_kind: str = "re-invoke",
    current_payload: dict | None = None,
    refresh_live_context: bool = True,
  ) -> bool:
    """Inject ``[system_label]\\n<prompt>`` as a system turn, re-invoke LLM2 in
    ``chat_id`` (always responding), and dispatch the reply.

    Returns ``True`` if a reply was produced and dispatched, ``False`` if LLM2
    failed or produced nothing usable. Mentions in ``prompt`` and in the chat's
    stored prompt override are rendered to ``@Name (senderRef)`` first.
    """
    invocation_context = await self._context_builder.build(
      chat_id,
      current_payload,
      refresh_live=refresh_live_context,
    )
    lock = self._per_chat_lock[chat_id]
    async with lock:
      history = self._per_chat[chat_id]
      system_text = f"[{system_label}]\n{render_stored_mentions(prompt, chat_id)}"
      # Append the instruction to history as a system turn so the model sees it
      # as the latest context (mirrors [SUBTASK FINISHED] / [SCHEDULED TASK]).
      history.append(WhatsAppMessage(
        timestamp_ms=int(time.time() * 1000),
        sender="system",
        text=system_text,
        role="system",
      ))

      current = WhatsAppMessage(
        timestamp_ms=int(time.time() * 1000),
        sender="system",
        context_msg_id="system",
        sender_ref=assistant_sender_ref(),
        text=system_text,
        role="system",
      )
      reinvoke_block = (
        f"## {block_title}\n"
        f"{system_text}\n\n"
        f"{block_instructions}"
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
            **invocation_context.generation_kwargs(),
            allow_subagent=False,
            scheduled_task_block=reinvoke_block,
          )
      except Exception as gen_err:  # pylint: disable=broad-except
        logger.exception(
          "%s: LLM2 re-invoke failed chat_id=%s: %s", log_kind, chat_id, gen_err,
          extra={"chat_id": chat_id},
        )
        reply_msg = None

      if reply_msg is None:
        logger.warning(
          "%s: LLM2 produced no reply chat_id=%s",
          log_kind, chat_id, extra={"chat_id": chat_id},
        )
        return False

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
      return True

  async def _dispatch_actions(
    self,
    chat_id: str,
    history,
    actions: list,
  ) -> None:
    """Dispatch the LLM2 actions from a cold re-invoke (subset mirror of the
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
        # Register the send so the action_ack hydrator upgrades the provisional
        # ``context_msg_id="pending"`` entry below to its real 6-digit id —
        # mirrors the normal message path (BatchProcessor) and the sub-agent
        # task-complete path (_deliver_subagent_result). Without this the
        # scheduled-task / direct-invoke / system-event reply stays "pending"
        # in history forever (the LLM can never reference its own message).
        if self._pending_send_request_chat is not None:
          self._pending_send_request_chat[request_id] = chat_id
          self._pending_send_request_chat.move_to_end(request_id)
          while len(self._pending_send_request_chat) > 4096:
            self._pending_send_request_chat.popitem(last=False)
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
      elif action_type == "run_command":
        await dispatch_llm_run_command(
          ws=self._ws,
          chat_id=chat_id,
          action=action,
          pending_run_command_chat=self._pending_run_command_chat,
        )
      else:
        logger.debug(
          "%s: ignoring unsupported action type=%s", "re-invoke", action_type,
          extra={"chat_id": chat_id},
        )
