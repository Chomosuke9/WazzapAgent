"""``SubAgentCoordinator`` — sub-agent submit / wait / deliver (Step 10).

Owns the ``execute_subtask`` flow that used to be threaded through
``process_message_batch`` and the module-level ``_deliver_subagent_result`` in
``session.py``:

  * :meth:`submit_subtask` — steering of an in-flight task, context-file
    staging, submit, completion/progress event registration, and the
    background wait task (``_run_subagent_post_processing`` +
    ``_run_correction_post_processing``) — session.py ~1487–2052.
  * :func:`_deliver_subagent_result` — stage outputs, re-invoke LLM2, dispatch
    actions, collect correction re-dispatches — moved here verbatim
    (session.py ~2395–2817).
  * :meth:`queue_event` — forwards sub-agent queue webhooks to WhatsApp
    (former ``_on_subagent_queue_event``).

Constructed with the owning :class:`AgentSession`; the per-session sub-agent
tracker / client / webhook stay INSTANCE-scoped (no module-level mutable
per-account state). All async timing (the keepalive/timeout loops, background
``asyncio.Task`` spawn, per-chat lock re-acquire) is byte-for-byte identical to
the original closures.
"""
from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
import time
import uuid
from collections import OrderedDict, defaultdict, deque
from dataclasses import dataclass, field
from typing import Deque, Dict, Set

from ..history import (
  WhatsAppMessage,
  assistant_name,
  assistant_sender_ref,
  assistant_name_pattern,
  format_history,
  hydrate_quoted_from_history,
)
from ..log import setup_logging, set_chat_log_context, reset_chat_log_context
from ..llm.llm1 import call_llm1, LLM1Decision
from ..llm.llm2 import generate_reply
from ..db import (
  get_mode as db_get_mode,
  get_triggers as db_get_triggers,
  is_muted as db_is_muted,
  is_mute_notified as db_is_mute_notified,
  mark_mute_notified as db_mark_mute_notified,
  add_mute as db_add_mute,
  remove_mute as db_remove_mute,
  clear_mutes as db_clear_mutes,
  get_mute_remaining_minutes as db_get_mute_remaining,
  set_permission as db_set_permission,
  set_llm2_model as db_set_llm2_model,
  clear_llm2_model_cache as db_clear_llm2_model_cache,
  clear_default_llm2_model_cache as db_clear_default_llm2_model_cache,
  reset_settings_connection as db_reset_settings_connection,
  invalidate_chat_caches as db_invalidate_chat_caches,
  close_all_connections as db_close_all_connections,
  checkpoint_all_dbs as db_checkpoint_all_dbs,
  get_subagent_enabled as db_get_subagent_enabled,
  set_subagent_enabled as db_set_subagent_enabled,
  clear_subagent_enabled_cache as db_clear_subagent_enabled_cache,
  get_idle_trigger as db_get_idle_trigger,
  is_chat_activated as db_is_chat_activated,
  set_tenant_db_dir as db_set_tenant_db_dir,
  reset_tenant_db_dir as db_reset_tenant_db_dir,
  tenant_db_context as db_tenant_db_context,
)
from ..dashboard import DashboardStats
from ..stickers import resolve_sticker
from ..messaging.processing import (
  _append_history,
  _append_or_merge_history_payload,
  _build_burst_current,
  _clean_text,
  _collect_context_ids,
  _extract_all_send_ack_entries,
  _extract_send_ack_context_msg_id,
  _hydrate_provisional_context_id_from_ack,
  _infer_media,
  _is_context_only_payload,
  _make_request_id,
  _normalize_context_msg_id,
  _normalize_preview_text,
  _payload_to_message,
  _quoted_preview,
  _reply_signature,
  extract_first_code_block,
)
from ..messaging.filtering import (
  _chat_state_from_payload,
  _message_matches_prefix,
  _payload_has_meaningful_content,
  _payload_triggers_llm1,
)
from ..llm.metadata import (
  _build_llm1_context_metadata,
  _resolve_group_prompt_context,
)
from ..messaging.moderation import (
  _merge_payload_attachments,
)
from ..messaging.actions import (
  _extract_actions,
  _extract_actions_from_tool_calls,
  _extract_reply_text,
)
from ..messaging.gateway import (
  send_attachment,
  send_copy_code,
  send_delete_message,
  send_kick_member,
  send_mark_read,
  send_message,
  send_quiz,
  send_react_message,
  send_run_command,
  send_sticker,
  send_lottie_sticker_payload,
  send_typing,
  typing_indicator,
)
from ..messaging.ack_handler import handle_action_ack as _handle_action_ack

from ..media import (
  _append_sticker_log_to_history,
  _cleanup_stale_media_paths,
  _guess_mime_from_path,
  _parse_sticker_args,
  _resolve_quoted_media_attachments,
  _resolve_sticker_media,
  _store_media_path,
)
from .idle_trigger import IdleTrigger
from .reply_dedup import ReplyDedup
from .mute_gate import MuteGate
from .llm1_router import Llm1Router
from .llm2_responder import Llm2Responder

from ..subagent import (
  SubTaskTracker,
  SubAgentClient,
  SubAgentSubmitError,
  SubAgentWebhookServer,
)
from ..subagent.output import (
  StagedOutputs,
  cleanup_input_staging,
  format_file_list,
  stage_input_files,
  stage_output_files,
)
from ..subagent.models import SubTask
from ..subagent.config import SUBAGENT_WAIT_TIMEOUT_S, SUBAGENT_MAX_WAIT_S, SUBAGENT_REPORT_MAX_CHARS

try:
  from ..config import (
    SLOW_BATCH_LOG_MS,
    MAX_TRIGGER_BATCH_AGE_MS,
    REPLY_DEDUP_WINDOW_MS,
    REPLY_DEDUP_MIN_CHARS,
    ASSISTANT_ECHO_MERGE_WINDOW_MS,
    INCOMING_DEBOUNCE_SECONDS,
    INCOMING_BURST_MAX_SECONDS,
    REQUIRE_ACTIVATION,
  )
except ImportError:
  from bridge.config import (  # type: ignore
    SLOW_BATCH_LOG_MS,
    MAX_TRIGGER_BATCH_AGE_MS,
    REPLY_DEDUP_WINDOW_MS,
    REPLY_DEDUP_MIN_CHARS,
    ASSISTANT_ECHO_MERGE_WINDOW_MS,
    INCOMING_DEBOUNCE_SECONDS,
    INCOMING_BURST_MAX_SECONDS,
    REQUIRE_ACTIVATION,
  )

logger = setup_logging()
from ..messaging.gateway import _dispatch_sticker


async def _deliver_subagent_result(
  *,
  ws,
  tracker,
  session_id: str,
  chat_id: str,
  history: deque,
  current,
  current_payload: dict,
  group_description: str | None,
  db_prompt: str | None,
  chat_type: str | None,
  bot_is_admin: bool,
  bot_is_super_admin: bool,
  fallback_reply_to: str | None,
  allowed_context_ids: set,
  record_stat_fn,
  responder,
  pending_subagent_attachments: dict | None = None,
  pending_send_request_chat: OrderedDict[str, str] | None = None,
) -> list[dict]:
  """Stage sub-agent outputs, re-invoke LLM2, and dispatch the resulting
  actions for a finalised sub-agent task.

  This is the second half of the ``execute_subtask`` flow. The first half
  (submit + register completion event) runs inline in the action loop;
  this half runs from a background task spawned in
  ``process_message_batch`` so the per-chat lock is no longer held while
  the sub-agent is in flight. The caller is expected to hold the per-chat
  lock for the duration of this call.

  ``tracker`` is the per-session :class:`SubTaskTracker` (was the module-level
  ``subagent_tracker`` global before Step 32's state isolation).

  Returns any ``execute_subtask`` actions extracted from the re-invoke
  that the caller should process (i.e. re-dispatch a correction sub-agent).
  """
  # Find the finalised task for THIS session_id (not just the chat's
  # most recent finalised entry). With the chat unlocked during the
  # sub-agent wait, a second sub-task could in principle have been
  # started and finished in the same chat between the wait completing
  # and the lock being re-acquired — addressing the right session keeps
  # the result delivery correct in that edge case.
  final_task = None
  finalized_history = tracker._history.get(chat_id) or []
  for candidate in reversed(finalized_history):
    if candidate.session_id == session_id:
      final_task = candidate
      break

  staged_outputs: StagedOutputs = StagedOutputs(staged=[], skipped=[])
  subagent_result_block: str | None = None
  if final_task is not None:
    if final_task.status == "completed":
      raw_paths = final_task.result.get("output_files") or []
      files_content = final_task.result.get("output_files_content") or []
      if (isinstance(raw_paths, list) and raw_paths) or (isinstance(files_content, list) and files_content):
        staged_outputs = await asyncio.to_thread(
          stage_output_files,
          session_id,
          raw_paths,
          files_content=files_content if files_content else None,
        )
        if staged_outputs.skipped:
          logger.warning(
            "execute_subtask: skipped %d output file(s) session=%s",
            len(staged_outputs.skipped),
            session_id,
            extra={
              "chat_id": chat_id,
              "skipped": [
                {"name": s.name, "reason": s.reason}
                for s in staged_outputs.skipped
              ],
            },
          )
    file_list_text = format_file_list(
      staged_outputs.staged, staged_outputs.skipped,
    )
    system_lines = [
      "[SUBTASK FINISHED]",
      f"Result: {final_task.report or 'No report'}",
      f"Success: {final_task.status == 'completed'}",
    ]
    if file_list_text:
      system_lines.append("")
      system_lines.append(file_list_text)
    if final_task.result.get("output_files_content_dropped"):
      system_lines.append("")
      system_lines.append(
        "Note: output file(s) could not be delivered because they were too "
        "large to transfer inline. Tell the user their file could not be sent."
      )
    subtask_finished_text = "\n".join(system_lines)
    history.append(WhatsAppMessage(
      timestamp_ms=int(time.time() * 1000),
      sender="system",
      text=subtask_finished_text,
      role="system",
    ))
    attachments_clause = (
      "Output files (if any) are auto-attached after your "
      "reply; do NOT mention paths or upload them yourself."
    )
    subagent_result_block = (
      "## Sub-Agent result for this turn\n"
      f"{subtask_finished_text}\n\n"
      "Instructions for this re-invoke:\n"
      "- Review the sub-agent's result carefully.\n"
      "- If you are satisfied, send EXACTLY ONE `reply_message` "
      "summarising the report for the user, in their language and "
      "WhatsApp formatting.\n"
      "- If the result is WRONG or INCOMPLETE (wrong file, wrong "
      "format, missing content, etc.), you may call `execute_subtask` "
      "AGAIN on this turn to correct it. This is the ONLY turn where "
      "you can re-dispatch — after your reply, the sub-agent result "
      "context is gone.\n"
      "- DO NOT repeat \"oke aku cek\" / \"siap, aku cek dokumennya\" "
      "or any other pre-task acknowledgement — the task is finished, "
      "deliver the actual result or dispatch a correction.\n"
      f"- {attachments_clause}\n"
      "- If the sub-agent reported failure, you may either tell the "
      "user briefly what failed (and suggest next steps) or call "
      "`execute_subtask` with a revised instruction to retry."
    )
  else:
    logger.warning(
      "execute_subtask: no finalised task found for session=%s chat=%s",
      session_id,
      chat_id,
      extra={"chat_id": chat_id, "session_id": session_id},
    )

  reinvoke_history = list(history)
  reply_msg = None
  try:
    llm2_reinvoke_started = time.perf_counter()
    async with typing_indicator(ws, chat_id):
      reply_msg = await responder.generate(
        reinvoke_history,
        current,
        current_payload=current_payload,
        group_description=group_description,
        prompt_override=db_prompt,
        chat_type=chat_type,
        bot_is_admin=bot_is_admin,
        bot_is_super_admin=bot_is_super_admin,
        allow_subagent=True,
        subagent_result_block=subagent_result_block,
      )
    llm2_reinvoke_ms = int((time.perf_counter() - llm2_reinvoke_started) * 1000)
    logger.info(
      "execute_subtask: re-invoke LLM2 completed in %dms session=%s",
      llm2_reinvoke_ms,
      session_id,
      extra={"chat_id": chat_id},
    )
  except Exception as reinvoke_err:  # pylint: disable=broad-except
    logger.exception(
      "execute_subtask: re-invoke LLM2 failed session=%s: %s",
      session_id,
      reinvoke_err,
      extra={"chat_id": chat_id},
    )
    reply_msg = None

  reinvoke_actions: list[dict] = []
  if reply_msg is not None:
    _tool_calls = getattr(reply_msg, 'tool_calls', None) or []
    if _tool_calls:
      reinvoke_actions = _extract_actions_from_tool_calls(
        _tool_calls,
        fallback_reply_to=fallback_reply_to,
        allowed_context_ids=allowed_context_ids,
      )
    else:
      reinvoke_actions = _extract_actions(
        reply_msg,
        fallback_reply_to=fallback_reply_to,
        allowed_context_ids=allowed_context_ids,
      )

  # Strict safety net: if the re-invoke produced no usable
  # ``send_message``, fall back to sending the raw report so the user at
  # least sees the result. Without this, a flaky LLM2 call after a
  # successful sub-agent run leaves the user staring at "oke aku cek
  # dulu" forever.
  has_reinvoke_text = any(
    a.get("type") == "send_message" and (a.get("text") or "").strip()
    for a in reinvoke_actions
  )
  if not has_reinvoke_text and final_task is not None:
    fallback_text = (
      final_task.report
      or ("Sub-agent failed without a report."
          if final_task.status != "completed"
          else "(Sub-agent finished but produced no report.)")
    )
    logger.warning(
      "execute_subtask: re-invoke produced no reply; falling back to raw report",
      extra={
        "chat_id": chat_id,
        "session_id": session_id,
        "had_reply_msg": reply_msg is not None,
        "reinvoke_action_count": len(reinvoke_actions),
      },
    )
    reinvoke_actions = [{
      "type": "send_message",
      "text": fallback_text,
      "replyTo": fallback_reply_to,
    }]

  for reinvoke_action in reinvoke_actions:
    reinvoke_type = reinvoke_action.get("type")
    if reinvoke_type == "send_message":
      reinvoke_text = reinvoke_action.get("text") or ""
      # Intentionally skip ``_is_duplicate_reply`` here. The re-invoke is
      # the *delivery* of the sub-agent result and may legitimately
      # rephrase the original acknowledgement.
      request_id = _make_request_id("send")
      await send_message(
        ws,
        chat_id,
        reinvoke_text,
        reinvoke_action.get("replyTo"),
        request_id=request_id,
      )
      record_stat_fn(chat_id, "responses_sent")
      if pending_send_request_chat is not None:
        pending_send_request_chat[request_id] = chat_id
        pending_send_request_chat.move_to_end(request_id)
        while len(pending_send_request_chat) > 4096:
          pending_send_request_chat.popitem(last=False)
      _prov_msg = WhatsAppMessage(
          timestamp_ms=int(time.time() * 1000),
          sender=assistant_name(),
          context_msg_id="pending",
          sender_ref=assistant_sender_ref(),
          sender_is_admin=False,
          text=reinvoke_text or None,
          media=None,
          quoted_message_id=_normalize_context_msg_id(reinvoke_action.get("replyTo")),
          quoted_sender=None,
          quoted_text=None,
          quoted_media=None,
          quoted_sender_ref=None,
          quoted_sender_is_admin=False,
          quoted_sender_is_super_admin=False,
          message_id=f"local-send-{request_id}",
          role="assistant",
        )
      hydrate_quoted_from_history(_prov_msg, history)
      _append_history(
        history,
        _prov_msg,
      )
      _code = extract_first_code_block(reinvoke_text)
      if _code:
        await send_copy_code(
          ws,
          chat_id,
          _code,
          quoted_preview_text=_normalize_preview_text(_code, limit=120),
          request_id=_make_request_id("copy"),
        )
    elif reinvoke_type == "react_message":
      await send_react_message(
        ws,
        chat_id,
        reinvoke_action.get("contextMsgId"),
        reinvoke_action.get("emoji"),
        request_id=_make_request_id("react"),
      )
    elif reinvoke_type == "express_message":
      reinvoke_expression = str(reinvoke_action.get("expression") or "").strip()
      if reinvoke_expression:
        sticker_info = resolve_sticker(reinvoke_expression, chat_id=chat_id)
        if sticker_info:
          _sticker_rid = _make_request_id("sticker")
          await _dispatch_sticker(
            ws,
            chat_id,
            sticker_info,
            reinvoke_action.get("contextMsgId"),
            request_id=_sticker_rid,
          )
          record_stat_fn(chat_id, "stickers_sent")
          _sticker_prov = WhatsAppMessage(
            timestamp_ms=int(time.time() * 1000),
            sender=assistant_name(),
            context_msg_id="pending",
            sender_ref=assistant_sender_ref(),
            sender_is_admin=False,
            text=f"<media:sticker={reinvoke_expression}>",
            media="sticker",
            quoted_message_id=_normalize_context_msg_id(reinvoke_action.get("contextMsgId")),
            quoted_sender=None,
            quoted_text=None,
            quoted_media=None,
            quoted_sender_ref=None,
            quoted_sender_is_admin=False,
            quoted_sender_is_super_admin=False,
            message_id=f"local-sticker-{_sticker_rid}",
            role="assistant",
          )
          hydrate_quoted_from_history(_sticker_prov, history)
          _append_history(history, _sticker_prov)
        else:
          await send_react_message(
            ws,
            chat_id,
            reinvoke_action.get("contextMsgId"),
            reinvoke_expression,
            request_id=_make_request_id("react"),
          )
    elif reinvoke_type == "delete_message":
      await send_delete_message(
        ws,
        chat_id,
        reinvoke_action.get("contextMsgId"),
        request_id=_make_request_id("delete"),
      )
    elif reinvoke_type == "kick_member":
      await send_kick_member(
        ws,
        chat_id,
        reinvoke_action.get("targets") or [],
        request_id=_make_request_id("kick"),
        mode=reinvoke_action.get("mode") or "partial_success",
        auto_reply_anchor=bool(reinvoke_action.get("autoReplyAnchor", False)),
      )

  # Collect execute_subtask actions from the re-invoke for the caller to
  # dispatch as correction sub-agent tasks. We do NOT process them inline
  # here — that requires the full submit/wait/background-task machinery.
  redispach_subagent_actions: list[dict] = [
    a for a in reinvoke_actions if a.get("type") == "execute_subtask"
  ]

  # bubble per file with no caption. Sent after the LLM2 text reply so
  # the conversation reads: text first, then files.
  #
  # For each attachment we:
  #   1. Build the request_id BEFORE sending so we can register the
  #      pending sub-agent attachment mapping.
  #   2. Send the attachment.
  #   3. Create a provisional history entry (message_id=local-send-<rid>)
  #      so that the action_ack handler can hydrate its context_msg_id.
  #   4. Register the staged file info in ``pending_subagent_attachments``
  #      so that the action_ack handler can store the path in
  #      ``media_paths_by_chat`` once the real contextMsgId arrives.
  for staged_file in staged_outputs.staged:
    attach_rid = _make_request_id("subagent_attach")
    try:
      await send_attachment(
        ws,
        chat_id,
        staged_file.path,
        staged_file.kind,
        request_id=attach_rid,
        file_name=staged_file.name,
        mime=staged_file.mime,
        thumbnail_base64=staged_file.thumbnail_base64,
      )
    except Exception as attach_err:  # pylint: disable=broad-except
      logger.exception(
        "execute_subtask: send_attachment failed session=%s file=%s: %s",
        session_id,
        staged_file.name,
        attach_err,
        extra={"chat_id": chat_id},
      )
      continue
    # Provisional history entry for the file attachment. The real
    # context_msg_id is filled in by ``_hydrate_provisional_context_id_from_ack``
    # when the gateway acknowledges the send.
    attach_media_label = staged_file.kind or "document"
    attach_media_text = staged_file.name if staged_file.name else None
    _prov_msg = WhatsAppMessage(
        timestamp_ms=int(time.time() * 1000),
        sender=assistant_name(),
        context_msg_id="pending",
        sender_ref=assistant_sender_ref(),
        sender_is_admin=False,
        text=attach_media_text,
        media=attach_media_label,
        quoted_message_id=None,
        quoted_sender=None,
        quoted_text=None,
        quoted_media=None,
        quoted_sender_ref=None,
        quoted_sender_is_admin=False,
        quoted_sender_is_super_admin=False,
        message_id=f"local-send-{attach_rid}",
        role="assistant",
    )
    hydrate_quoted_from_history(_prov_msg, history)
    _append_history(
      history,
      _prov_msg,
    )
    # Register in pending_subagent_attachments so the action_ack handler
    # can store the file path in media_paths_by_chat under the real
    # contextMsgId once it arrives.
    if pending_subagent_attachments is not None:
      pending_subagent_attachments[attach_rid] = (chat_id, [{
        "kind": staged_file.kind,
        "mime": staged_file.mime,
        "fileName": staged_file.name,
        "path": staged_file.path,
      }])
      pending_subagent_attachments.move_to_end(attach_rid)
      while len(pending_subagent_attachments) > 4096:
        pending_subagent_attachments.popitem(last=False)

  # Defer clearing finished-task history until AFTER any correction
  # sub-agent actions are processed. If LLM2 re-dispatched a correction
  # task, the "recently finished" context is useful for the next turn.
  if not redispach_subagent_actions:
    tracker.clear_history_for_chat(chat_id)

  return redispach_subagent_actions


class SubAgentCoordinator:
  """Per-account sub-agent coordinator (Step 10). See module docstring."""

  def __init__(self, session) -> None:
    self._session = session

  async def queue_event(
    self,
    chat_id: str,
    event_type: str,
    position: int,
    queue_size: int,
  ) -> None:
    # Forward sub-agent queue webhooks to WhatsApp (former
    # ``_on_subagent_queue_event``). Uses the live per-session socket.
    ws = self._session.sock
    if event_type == "queued":
      text = f"container is used by other session.\ncurrent queue: {position}"
    else:
      # ``queue_advanced`` / ``queue_status`` are position updates; skip
      # the "used by other session" preamble — the user already saw it.
      text = f"current queue: {position}"
    try:
      await send_message(
        ws,
        chat_id,
        text,
        None,
        request_id=_make_request_id("subagent_queue"),
      )
    except Exception as exc:  # pylint: disable=broad-except
      # Log and re-raise so the webhook server's dedup-on-failure
      # safeguard kicks in (it returns HTTP 500 + skips _record_queue_emit
      # so a sub-agent retry within the dedup window is delivered, not
      # silently suppressed).
      logger.warning(
        "Failed to deliver subagent queue notification chat=%s type=%s: %s",
        chat_id,
        event_type,
        exc,
      )
      raise

  async def submit_subtask(
    self,
    *,
    action,
    chat_id,
    history,
    lock,
    current,
    llm2_payload,
    group_description,
    db_prompt,
    chat_type,
    bot_is_admin,
    bot_is_super_admin,
    fallback_reply_to,
    allowed_context_ids,
  ):
    session = self._session
    ws = session.sock
    subagent_tracker = session.subagent_tracker
    subagent_client = session.subagent_client
    subagent_webhook = session.subagent_webhook
    media_paths_by_chat = session.media_paths_by_chat
    pending_subagent_attachments = session.pending_subagent_attachments
    pending_send_request_chat = session.pending_send_request_chat
    _track_task = session._track_task
    # Reject duplicate execute_subtask while another sub-agent task
    # is already in flight for this chat. The "Active sub-agent
    # task" context block (see SubTaskTracker.format_context) tells
    # LLM2 not to re-spawn, but a server-side guard means a flaky
    # model that ignores the prompt cannot fork the same chat into
    # parallel sub-agents. Without this, refactoring the wait into
    # a background task (so the chat is no longer locked while the
    # sub-agent runs) would let bursts arriving mid-task spawn
    # concurrent sub-agents.
    existing_task = subagent_tracker.get_active_for_chat(chat_id)
    if existing_task is not None:
      _incoming = str(action.get("instruction") or "").strip()
      if _incoming:
        logger.info(
          "execute_subtask: forwarding as steering to running "
          "sub-agent chat=%s active_session=%s instruction=%s",
          chat_id,
          existing_task.session_id,
          _incoming[:120],
          extra={"chat_id": chat_id},
        )
        await subagent_client.steer(existing_task.session_id, _incoming)
      else:
        logger.warning(
          "execute_subtask: dropped (no instruction) for chat=%s",
          chat_id,
          extra={"chat_id": chat_id},
        )
      return

    session_id = f"{chat_id}_{uuid.uuid4().hex[:8]}_{int(time.time())}"
    instruction = action["instruction"]
    ctx_ids = action.get("contextMsgIds", [])
    high_quality = action.get("high_quality", False)

    # Resolve contextMsgIds -> media file paths AND/OR text content.
    # Media comes from ``media_paths_by_chat``; text comes from the
    # in-memory history deque (``per_chat[chat_id]``, already bound
    # to ``history`` above). A single contextMsgId can carry both a
    # media attachment *and* text (e.g. an image with a caption), so
    # both branches run independently for each cid.
    local_input_files: list[str] = []
    chat_store = media_paths_by_chat.get(chat_id, {})
    tmp_dir = tempfile.mkdtemp(prefix="subagent_ctx_")
    try:
      file_idx = 1

      for cid in ctx_ids:
        # --- media resolution ---
        atts = chat_store.get(cid)
        media_path = None
        if isinstance(atts, list) and atts:
          first = atts[0]
          p = first.get("path") if isinstance(first, dict) else None
          if p and os.path.isfile(p):
            media_path = p
        elif isinstance(atts, str) and os.path.isfile(atts):
          media_path = atts

        if media_path:
          ext = os.path.splitext(media_path)[1] or ".bin"
          renamed = os.path.join(tmp_dir, f"media{file_idx}{ext}")
          shutil.copyfile(media_path, renamed)
          local_input_files.append(renamed)
          file_idx += 1

        # --- text resolution (on-demand scan of history deque) ---
        msg_text = None
        for msg in history:
          if msg.context_msg_id == cid and msg.text:
            msg_text = msg.text
            break

        if msg_text:
          txt_path = os.path.join(tmp_dir, f"user_message{file_idx}.txt")
          with open(txt_path, "w", encoding="utf-8") as f:
            f.write(msg_text)
          local_input_files.append(txt_path)
          file_idx += 1

      # The bridge stores inbound media under MEDIA_DIR (e.g.
      # ``data/media/...``), but the sub-agent process runs in a
      # separate container/host that cannot read those paths. Stage
      # them into the cross-process exchange directory so the paths
      # we hand to /execute resolve on both sides. See
      # ``subagent/output.py::input_staging_root`` for the contract.
      input_files = stage_input_files(session_id, local_input_files)
    finally:
      shutil.rmtree(tmp_dir, ignore_errors=True)

    task = SubTask(session_id=session_id, instruction=instruction, chat_id=chat_id)
    subagent_tracker.register(task)

    logger.info(
      "execute_subtask: submitting session=%s instruction=%s files=%d (staged=%d) high_quality=%s",
      session_id,
      instruction[:120],
      len(local_input_files),
      len(input_files),
      high_quality,
      extra={
        "chat_id": chat_id,
        "session_id": session_id,
        "local_input_files": local_input_files,
        "input_files": input_files,
        "high_quality": high_quality,
      },
    )

    # IMPORTANT: register the completion event BEFORE submit. If the
    # SubAgent finishes very quickly (or returns synchronously), the
    # webhook may arrive before we have a chance to register and the
    # event would be lost — leading to a full timeout wait.
    completion_event = asyncio.Event()
    subagent_webhook.register_completion_event(session_id, completion_event)
    # Keepalive event: set each time a progress webhook arrives so
    # the timeout resets instead of treating a slow but alive
    # sub-agent as dead.
    progress_event = asyncio.Event()
    subagent_webhook.register_progress_event(session_id, progress_event)

    submit_failed = False
    try:
      await subagent_client.submit(session_id, instruction, input_files, high_quality=high_quality)
    except SubAgentSubmitError as submit_err:
      logger.error(
        "execute_subtask: submit failed session=%s status=%s: %s",
        session_id,
        submit_err.status_code,
        submit_err,
        extra={"chat_id": chat_id, "session_id": session_id},
      )
      subagent_webhook.unregister_completion_event(session_id)
      subagent_webhook.unregister_progress_event(session_id)
      subagent_tracker.finalize(session_id, {
        "success": False,
        "report": f"Failed to submit task to sub-agent: {submit_err}",
      })
      submit_failed = True
    except Exception as submit_err:
      logger.exception(
        "execute_subtask: submit failed session=%s: %s",
        session_id,
        submit_err,
        extra={"chat_id": chat_id},
      )
      subagent_webhook.unregister_completion_event(session_id)
      subagent_webhook.unregister_progress_event(session_id)
      subagent_tracker.finalize(session_id, {
        "success": False,
        "report": f"Failed to submit task to sub-agent: {submit_err}",
      })
      submit_failed = True

    if submit_failed:
      # No webhook will arrive; trip the event immediately so the
      # background task wakes up and delivers the failure report
      # without waiting out the full SUBAGENT_WAIT_TIMEOUT_S.
      completion_event.set()

    # Capture closure variables that the background task needs.
    # We capture by argument default to avoid late-binding bugs if
    # the loop processes more actions before the task is scheduled.
    _bg_session_id = session_id
    _bg_chat_id = chat_id
    _bg_completion_event = completion_event
    _bg_progress_event = progress_event
    _bg_history = history
    _bg_lock = lock
    _bg_current = current
    _bg_current_payload = llm2_payload
    _bg_group_description = group_description
    _bg_db_prompt = db_prompt
    _bg_chat_type = chat_type
    _bg_bot_is_admin = bot_is_admin
    _bg_bot_is_super_admin = bot_is_super_admin
    _bg_fallback_reply_to = fallback_reply_to
    _bg_allowed_context_ids = allowed_context_ids

    async def _run_subagent_post_processing(
      session_id: str = _bg_session_id,
      chat_id: str = _bg_chat_id,
      completion_event: asyncio.Event = _bg_completion_event,
      progress_event: asyncio.Event = _bg_progress_event,
      history=_bg_history,
      lock: asyncio.Lock = _bg_lock,
      current=_bg_current,
      current_payload=_bg_current_payload,
      group_description=_bg_group_description,
      db_prompt=_bg_db_prompt,
      chat_type=_bg_chat_type,
      bot_is_admin=_bg_bot_is_admin,
      bot_is_super_admin=_bg_bot_is_super_admin,
      fallback_reply_to=_bg_fallback_reply_to,
      allowed_context_ids=_bg_allowed_context_ids,
    ) -> None:
      """Wait for the sub-agent to finish, then re-invoke LLM2 and
      deliver the result.

      Runs as a background ``asyncio.Task`` so the per-chat lock is
      released as soon as the original action loop exits. New
      bursts arriving in the same chat while the sub-agent is
      running are processed normally (LLM2 sees the active-task
context block from ``SubTaskTracker.format_context``).
      """
      try:
        try:
          # Wait for the sub-agent to finish. The always-on webhook
          # server sets ``completion_event`` on the ``complete``
          # callback, and ``progress_event`` on every ``progress``
          # callback. The keepalive loop below resets the timeout
          # each time a progress event arrives, so a slow but still-
          # working sub-agent is not incorrectly declared dead.
          # An absolute ceiling (SUBAGENT_MAX_WAIT_S) prevents
          # infinite hangs.
          start_time = time.monotonic()
          timed_out = False
          while True:
            remaining = SUBAGENT_MAX_WAIT_S - (time.monotonic() - start_time)
            if remaining <= 0:
              # Absolute maximum exceeded.
              logger.error(
                "execute_subtask: absolute max wait exceeded session=%s — "
                "sub-agent did not finish within %ss total",
                session_id,
                SUBAGENT_MAX_WAIT_S,
                extra={"chat_id": chat_id},
              )
              subagent_webhook.unregister_completion_event(session_id)
              subagent_webhook.unregister_progress_event(session_id)
              subagent_tracker.finalize(session_id, {
                "success": False,
                "report": (
                  f"Sub-agent did not return a result within "
                  f"{int(SUBAGENT_MAX_WAIT_S)}s total. The task may "
                  f"be too complex or the sub-agent is stuck."
                ),
              })
              timed_out = True
              break

            try:
              await asyncio.wait_for(
                completion_event.wait(), timeout=SUBAGENT_WAIT_TIMEOUT_S
              )
              # completion_event was set — sub-agent finished.
              break
            except asyncio.TimeoutError:
              # Check completion first (race: webhook arrived just
              # as the timeout fired).
              if completion_event.is_set():
                break
              # Progress keepalive received — the sub-agent is
              # still alive, so reset the per-batch timeout.
              if progress_event.is_set():
                progress_event.clear()
                logger.info(
                  "execute_subtask: progress keepalive — resetting timeout session=%s",
                  session_id,
                  extra={"chat_id": chat_id},
                )
                continue
              # No completion and no progress for a full
              # SUBAGENT_WAIT_TIMEOUT_S — true timeout.
              logger.error(
                "execute_subtask: webhook timeout session=%s — "
                "sub-agent did not call back within %ss (no progress)",
                session_id,
                SUBAGENT_WAIT_TIMEOUT_S,
                extra={"chat_id": chat_id},
              )
              subagent_webhook.unregister_completion_event(session_id)
              subagent_webhook.unregister_progress_event(session_id)
              subagent_tracker.finalize(session_id, {
                "success": False,
                "report": (
                  f"Sub-agent did not return a result within "
                  f"{int(SUBAGENT_WAIT_TIMEOUT_S)}s and sent no "
                  f"progress updates. The webhook server is "
                  f"always-on, so this likely means the sub-agent "
                  f"service crashed or the network is partitioned."
                ),
              })
              timed_out = True
              break

          # Acquire the per-chat lock for history mutation + send.
          # Other bursts arriving on this chat during the wait above
          # have already been processed (LLM2 saw the active-task
          # context block telling it not to re-acknowledge or
          # re-spawn); now we deliver the report.
          async with lock:
            redispach_actions = await _deliver_subagent_result(
              ws=ws,
              tracker=subagent_tracker,
              session_id=session_id,
              chat_id=chat_id,
              history=history,
              current=current,
              current_payload=current_payload,
              group_description=group_description,
              db_prompt=db_prompt,
              chat_type=chat_type,
              bot_is_admin=bot_is_admin,
              bot_is_super_admin=bot_is_super_admin,
              fallback_reply_to=fallback_reply_to,
              allowed_context_ids=allowed_context_ids,
              record_stat_fn=record_stat,
              responder=session._llm2,
              pending_subagent_attachments=pending_subagent_attachments,
              pending_send_request_chat=pending_send_request_chat,
            )
            # If LLM2 re-dispatched a correction sub-agent task,
            # process it as a new execute_subtask action. We run
            # this INSIDE the per-chat lock so there's no race with
            # other bursts, and the submit/background-wait flow
            # releases the lock via a new background task.
            for action in redispach_actions:
              _action_type = action.get("type")
              if _action_type != "execute_subtask":
                continue
              existing_task = subagent_tracker.get_active_for_chat(chat_id)
              if existing_task is not None:
                logger.warning(
                  "execute_subtask: dropped correction dispatch because "
                  "another sub-agent is already active for chat=%s",
                  chat_id,
                  extra={"chat_id": chat_id},
                )
                continue
              _ctx_ids = action.get("contextMsgIds") or []
              _instruction = str(action.get("instruction") or "").strip()
              _high_quality = bool(action.get("high_quality", False))
              _conf_text = str(action.get("confirmation_text") or "").strip()
              if not _instruction:
                continue
              # Send confirmation text if provided
              if _conf_text:
                _conf_rid = _make_request_id("send")
                await send_message(ws, chat_id, _conf_text, fallback_reply_to, request_id=_conf_rid)
                session._dashboard.record_stat(chat_id, "responses_sent")
              _new_session_id = f"{chat_id}_{uuid.uuid4().hex[:8]}_{int(time.time())}"
              _local_files: list[str] = []
              _tmp_dir = tempfile.mkdtemp(prefix="subagent_ctx_")
              try:
                _fidx = 1
                for _cid in _ctx_ids:
                  _atts = media_paths_by_chat.get(chat_id, {}).get(_cid)
                  _media_path = None
                  if isinstance(_atts, list) and _atts:
                    _first = _atts[0]
                    _p = _first.get("path") if isinstance(_first, dict) else None
                    if _p and os.path.isfile(_p):
                      _media_path = _p
                  elif isinstance(_atts, str) and os.path.isfile(_atts):
                    _media_path = _atts
                  if _media_path:
                    _ext = os.path.splitext(_media_path)[1] or ".bin"
                    _renamed = os.path.join(_tmp_dir, f"media{_fidx}{_ext}")
                    shutil.copyfile(_media_path, _renamed)
                    _local_files.append(_renamed)
                    _fidx += 1
                  _msg_text = None
                  for _msg in history:
                    if _msg.context_msg_id == _cid and _msg.text:
                      _msg_text = _msg.text
                      break
                  if _msg_text:
                    _txt_path = os.path.join(_tmp_dir, f"user_message{_fidx}.txt")
                    with open(_txt_path, "w", encoding="utf-8") as _f:
                      _f.write(_msg_text)
                    _local_files.append(_txt_path)
                    _fidx += 1
                _input_files = stage_input_files(_new_session_id, _local_files)
              finally:
                shutil.rmtree(_tmp_dir, ignore_errors=True)
              _task = SubTask(session_id=_new_session_id, instruction=_instruction, chat_id=chat_id)
              subagent_tracker.register(_task)
              logger.info(
                "execute_subtask: correction dispatch session=%s instruction=%s",
                _new_session_id,
                _instruction[:120],
                extra={"chat_id": chat_id},
              )
              _new_completion_event = asyncio.Event()
              _new_progress_event = asyncio.Event()
              subagent_webhook.register_completion_event(_new_session_id, _new_completion_event)
              subagent_webhook.register_progress_event(_new_session_id, _new_progress_event)
              _new_submit_failed = False
              try:
                await subagent_client.submit(
                    _new_session_id, _instruction, _input_files,
                    high_quality=_high_quality,
                    previous_session_id=session_id,
                )
              except Exception as _submit_err:
                logger.exception(
                  "execute_subtask: correction submit failed session=%s: %s",
                  _new_session_id, _submit_err,
                  extra={"chat_id": chat_id},
                )
                subagent_webhook.unregister_completion_event(_new_session_id)
                subagent_webhook.unregister_progress_event(_new_session_id)
                subagent_tracker.finalize(_new_session_id, {
                  "success": False,
                  "report": f"Failed to submit correction task: {_submit_err}",
                })
                _new_submit_failed = True
              if _new_submit_failed:
                _new_completion_event.set()
              # Clear the now-stale finished-task history so the
              # next turn doesn't inject a "recently finished"
              # block that would confuse the model.
              subagent_tracker.clear_history_for_chat(chat_id)
              # Spawn a new background task to wait for the
              # correction sub-agent and deliver its result.
              _bg2_session_id = _new_session_id
              _bg2_chat_id = chat_id
              _bg2_completion_event = _new_completion_event
              _bg2_progress_event = _new_progress_event
              _bg2_history = history
              _bg2_lock = lock
              _bg2_current = current
              _bg2_current_payload = current_payload
              _bg2_group_description = group_description
              _bg2_db_prompt = db_prompt
              _bg2_chat_type = chat_type
              _bg2_bot_is_admin = bot_is_admin
              _bg2_bot_is_super_admin = bot_is_super_admin
              _bg2_fallback_reply_to = fallback_reply_to
              _bg2_allowed_context_ids = allowed_context_ids

              async def _run_correction_post_processing(
                session_id=_bg2_session_id,
                chat_id=_bg2_chat_id,
                completion_event=_bg2_completion_event,
                progress_event=_bg2_progress_event,
                history=_bg2_history,
                lock=_bg2_lock,
                current=_bg2_current,
                current_payload=_bg2_current_payload,
                group_description=_bg2_group_description,
                db_prompt=_bg2_db_prompt,
                chat_type=_bg2_chat_type,
                bot_is_admin=_bg2_bot_is_admin,
                bot_is_super_admin=_bg2_bot_is_super_admin,
                fallback_reply_to=_bg2_fallback_reply_to,
                allowed_context_ids=_bg2_allowed_context_ids,
              ):
                try:
                  start_time = time.monotonic()
                  timed_out = False
                  while True:
                    remaining = SUBAGENT_MAX_WAIT_S - (time.monotonic() - start_time)
                    if remaining <= 0:
                      logger.error(
                        "execute_subtask: correction max wait exceeded session=%s",
                        session_id,
                        extra={"chat_id": chat_id},
                      )
                      subagent_webhook.unregister_completion_event(session_id)
                      subagent_webhook.unregister_progress_event(session_id)
                      subagent_tracker.finalize(session_id, {
                        "success": False,
                        "report": f"Correction sub-agent did not finish within {int(SUBAGENT_MAX_WAIT_S)}s.",
                      })
                      timed_out = True
                      break
                    try:
                      await asyncio.wait_for(completion_event.wait(), timeout=SUBAGENT_WAIT_TIMEOUT_S)
                      break
                    except asyncio.TimeoutError:
                      if completion_event.is_set():
                        break
                      if progress_event.is_set():
                        progress_event.clear()
                        continue
                      logger.error(
                        "execute_subtask: correction webhook timeout session=%s",
                        session_id,
                        extra={"chat_id": chat_id},
                      )
                      subagent_webhook.unregister_completion_event(session_id)
                      subagent_webhook.unregister_progress_event(session_id)
                      subagent_tracker.finalize(session_id, {
                        "success": False,
                        "report": "Correction sub-agent timed out.",
                      })
                      timed_out = True
                      break
                  async with lock:
                    await _deliver_subagent_result(
                      ws=ws,
                      tracker=subagent_tracker,
                      session_id=session_id,
                      chat_id=chat_id,
                      history=history,
                      current=current,
                      current_payload=current_payload,
                      group_description=group_description,
                      db_prompt=db_prompt,
                      chat_type=chat_type,
                      bot_is_admin=bot_is_admin,
                      bot_is_super_admin=bot_is_super_admin,
                      fallback_reply_to=fallback_reply_to,
                      allowed_context_ids=allowed_context_ids,
                      record_stat_fn=record_stat,
                      responder=session._llm2,
                      pending_subagent_attachments=pending_subagent_attachments,
                      pending_send_request_chat=pending_send_request_chat,
                    )
                except asyncio.CancelledError:
                  raise
                except Exception as _bg_err:
                  logger.exception(
                    "execute_subtask: correction background processing failed session=%s: %s",
                    session_id, _bg_err,
                    extra={"chat_id": chat_id},
                  )
                finally:
                  subagent_webhook.unregister_progress_event(session_id)
                  try:
                    cleanup_input_staging(session_id)
                  except Exception:
                    pass

              _bg2_task = asyncio.create_task(_run_correction_post_processing())
              _track_task(_bg2_task)
        finally:
          # Always best-effort clean up the per-session input
          # staging dir, including on ``asyncio.CancelledError``
          # during shutdown — otherwise WhatsApp media copies
          # leak on disk every time a sub-agent is in flight at
          # shutdown. Output files in ``MEDIA_DIR/subagent_out/``
          # are intentionally kept (Node may still need them).
          # Also clean up the progress event; the completion
          # event is cleaned up by the webhook server on
          # ``complete``, but a timeout or cancel path may
          # miss it.
          subagent_webhook.unregister_progress_event(session_id)
          try:
            cleanup_input_staging(session_id)
          except Exception as cleanup_err:  # pylint: disable=broad-except
            logger.warning(
              "execute_subtask: input staging cleanup failed session=%s: %s",
              session_id,
              cleanup_err,
              extra={"chat_id": chat_id},
            )
      except asyncio.CancelledError:
        raise
      except Exception as bg_err:  # pylint: disable=broad-except
        logger.exception(
          "execute_subtask: background processing failed session=%s: %s",
          session_id,
          bg_err,
          extra={"chat_id": chat_id},
        )

    bg_task = asyncio.create_task(_run_subagent_post_processing())
    _track_task(bg_task)
    return
