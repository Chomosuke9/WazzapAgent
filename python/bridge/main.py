from __future__ import annotations

import asyncio
import atexit
import json
import os
import random
import shutil
import signal
import tempfile
import time
import uuid
from collections import OrderedDict, defaultdict, deque
from dataclasses import dataclass, field
from typing import Deque, Dict, Set
from urllib.parse import urlsplit

import websockets
from dotenv import load_dotenv

try:
  from .history import (
    WhatsAppMessage,
    assistant_name,
    assistant_sender_ref,
    assistant_name_pattern,
    format_history,
    hydrate_quoted_from_history,
  )
  from .log import setup_logging, set_chat_log_context, reset_chat_log_context
  from .llm.llm1 import call_llm1, LLM1Decision
  from .llm.llm2 import generate_reply
  from .db import (
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
  )
  from .dashboard import record_stat, record_user_invoke, flush_to_db, start_flush_loop
  from .stickers import resolve_sticker
  from .tools.sticker import create_sticker_file
  from .messaging.processing import (
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
  from .messaging.filtering import (
    _chat_state_from_payload,
    _message_matches_prefix,
    _payload_has_meaningful_content,
    _payload_triggers_llm1,
  )
  from .llm.metadata import (
    _build_llm1_context_metadata,
    _resolve_group_prompt_context,
  )
  from .messaging.moderation import (
    _merge_payload_attachments,
  )
  from .messaging.actions import (
    _extract_actions,
    _extract_actions_from_tool_calls,
    _extract_reply_text,
  )
  from .messaging.gateway import (
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
except ImportError:  # allow running as `python python/bridge/main.py`
  import sys
  from pathlib import Path
  sys.path.append(str(Path(__file__).resolve().parent.parent))
  from bridge.history import (  # type: ignore
    WhatsAppMessage,
    assistant_name,
    assistant_sender_ref,
    assistant_name_pattern,
    format_history,
    hydrate_quoted_from_history,
  )
  from bridge.log import setup_logging, set_chat_log_context, reset_chat_log_context  # type: ignore
  from bridge.llm.llm1 import call_llm1, LLM1Decision  # type: ignore
  from bridge.llm.llm2 import generate_reply  # type: ignore
  from bridge.commands import parse_command, handle_command, CommandResult  # type: ignore
  from bridge.db import (  # type: ignore
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
  )
  from bridge.dashboard import record_stat, record_user_invoke, flush_to_db, start_flush_loop  # type: ignore
  from bridge.stickers import resolve_sticker  # type: ignore
  from bridge.tools.sticker import create_sticker_file  # type: ignore
  from bridge.messaging.processing import (  # type: ignore
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
  from bridge.messaging.filtering import (  # type: ignore
    _chat_state_from_payload,
    _message_matches_prefix,
    _payload_has_meaningful_content,
    _payload_triggers_llm1,
  )
  from bridge.llm.metadata import (  # type: ignore
    _build_llm1_context_metadata,
    _resolve_group_prompt_context,
  )
  from bridge.messaging.moderation import (  # type: ignore
    _merge_payload_attachments,
  )
  from bridge.messaging.actions import (  # type: ignore
    _extract_actions,
    _extract_actions_from_tool_calls,
    _extract_reply_text,
  )
  from bridge.messaging.gateway import (  # type: ignore
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

load_dotenv()

try:
  from .subagent import (
    SubTaskTracker,
    SubAgentClient,
    SubAgentSubmitError,
    SubAgentWebhookServer,
  )
  from .subagent.output import (
    StagedOutputs,
    cleanup_input_staging,
    format_file_list,
    stage_input_files,
    stage_output_files,
  )
  from .subagent.models import SubTask
  from .subagent.config import SUBAGENT_WAIT_TIMEOUT_S, SUBAGENT_MAX_WAIT_S, SUBAGENT_REPORT_MAX_CHARS
except ImportError:
  import sys
  from pathlib import Path
  sys.path.append(str(Path(__file__).resolve().parent.parent))
  from bridge.subagent import (  # type: ignore
    SubTaskTracker,
    SubAgentClient,
    SubAgentSubmitError,
    SubAgentWebhookServer,
  )
  from bridge.subagent.output import (  # type: ignore
    StagedOutputs,
    cleanup_input_staging,
    format_file_list,
    stage_input_files,
    stage_output_files,
  )
  from bridge.subagent.models import SubTask  # type: ignore
  from bridge.subagent.config import (  # type: ignore
    SUBAGENT_WAIT_TIMEOUT_S,
    SUBAGENT_MAX_WAIT_S,
    SUBAGENT_REPORT_MAX_CHARS,
  )

try:
  from .config import (
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

# ---------------------------------------------------------------------------
# SubAgent global instances
# ---------------------------------------------------------------------------
subagent_tracker = SubTaskTracker()
subagent_client = SubAgentClient()
subagent_webhook = SubAgentWebhookServer(subagent_tracker)

# Backward compat re-exports (used by tests).
# _quoted_preview, _build_burst_current, and _build_llm1_context_metadata
# are imported above and are available as module-level names.


# ---------------------------------------------------------------------------
# Sticker command helpers
# ---------------------------------------------------------------------------

def _parse_sticker_args(args: str) -> tuple[str | None, str | None]:
  """Parse '/sticker upper#lower' args → (upper_text, lower_text). Either may be None."""
  if "#" in args:
    upper, _, lower = args.partition("#")
    return upper.strip() or None, lower.strip() or None
  return args.strip() or None, None


def _store_media_path(media_paths_by_chat: dict, payload: dict) -> None:
  """Record attachment file paths keyed by (chat_id, context_msg_id) for later lookup.

  Stores ALL attachment kinds (image, sticker, document, audio, video),
  not just visual media. This enables LLM2 to reference any file path
  when delegating tasks to the sub-agent.
  """
  ctx_id = payload.get("contextMsgId")
  chat_id = payload.get("chatId")
  atts = payload.get("attachments") or []
  if not ctx_id or not chat_id:
    return
  paths = []
  for att in atts:
    if isinstance(att, dict):
      p = att.get("path")
      if p:
        paths.append({
          "kind": str(att.get("kind", "")).lower(),
          "mime": att.get("mime", ""),
          "fileName": att.get("fileName", ""),
          "originalFileName": att.get("originalFileName") or None,
          "jpegThumbnail": att.get("jpegThumbnail") or None,
          "path": p,
          "received_at": time.time(),
        })
  if paths:
    media_paths_by_chat.setdefault(chat_id, {})[ctx_id] = paths


def _cleanup_stale_media_paths(media_paths_by_chat: dict, max_age_seconds: float = 86400.0) -> int:
  """Remove media path entries older than max_age_seconds. Returns count removed."""
  now = time.time()
  removed = 0
  for chat_id in list(media_paths_by_chat.keys()):
    ctx_map = media_paths_by_chat[chat_id]
    for ctx_id in list(ctx_map.keys()):
      entries = ctx_map[ctx_id]
      if isinstance(entries, list) and entries:
        if all(now - e.get("received_at", now) > max_age_seconds for e in entries):
          del ctx_map[ctx_id]
          removed += 1
    if not ctx_map:
      del media_paths_by_chat[chat_id]
  return removed


def _resolve_quoted_media_attachments(
  media_paths_by_chat: dict,
  payload: dict,
  chat_id: str,
) -> list[dict]:
  """Resolve media attachments from the quoted message and the current payload.

  If the current payload already has visual attachments, return those.
  Otherwise, if the quoted message had previously-tracked media files,
  build attachment dicts from the stored paths and return them.
  """
  # First: check if current payload already has visual attachments
  atts = list(payload.get("attachments") or [])
  visual_kinds = {"image", "sticker"}
  has_visual = any(
    isinstance(att, dict) and (
      str(att.get("kind", "")).lower() in visual_kinds
      or (str(att.get("kind", "")).lower() == "document" and att.get("jpegThumbnail"))
    )
    for att in atts
  )
  if has_visual:
    logger.debug(
      "resolve_quoted_media: current payload has %d visual attachment(s), using those",
      sum(1 for a in atts if isinstance(a, dict) and str(a.get("kind", "")).lower() in visual_kinds),
      extra={"chat_id": chat_id},
    )
    return atts  # Already has visual attachments from the current message

  # Second: check quoted message for previously tracked media
  quoted = payload.get("quoted") or {}
  quoted_ctx_id = quoted.get("contextMsgId")
  if not quoted_ctx_id:
    logger.debug(
      "resolve_quoted_media: no current visual attachments and no quoted contextMsgId",
      extra={"chat_id": chat_id},
    )
    return atts

  stored = media_paths_by_chat.get(chat_id, {}).get(quoted_ctx_id)
  if not stored:
    logger.debug(
      "resolve_quoted_media: no stored media for quoted contextMsgId=%s",
      quoted_ctx_id,
      extra={"chat_id": chat_id},
    )
    return atts

  # stored can be a list of dicts (new format) or a single string path (legacy)
  resolved = []
  if isinstance(stored, list):
    for entry in stored:
      if isinstance(entry, dict) and entry.get("path") and os.path.isfile(entry["path"]):
        resolved.append({
          "kind": entry.get("kind", "image"),
          "mime": entry.get("mime") or _guess_mime_from_path(entry["path"]),
          "fileName": entry.get("fileName") or os.path.basename(entry["path"]),
          "originalFileName": entry.get("originalFileName") or None,
          "jpegThumbnail": entry.get("jpegThumbnail") or None,
          "path": entry["path"],
        })
  elif isinstance(stored, str) and os.path.isfile(stored):
    resolved.append({
      "kind": "sticker" if stored.lower().endswith(".webp") else "image",
      "mime": _guess_mime_from_path(stored),
      "fileName": os.path.basename(stored),
      "originalFileName": None,
      "jpegThumbnail": None,
      "path": stored,
    })

  if not resolved:
    logger.debug(
      "resolve_quoted_media: stored media found but files missing on disk",
      extra={"chat_id": chat_id, "quoted_ctx_id": quoted_ctx_id},
    )
    return atts

  logger.info(
    "resolve_quoted_media: resolving %d visual attachment(s) from quoted message (contextMsgId=%s)",
    len(resolved),
    quoted_ctx_id,
    extra={"chat_id": chat_id},
  )
  return atts + resolved


def _guess_mime_from_path(file_path: str) -> str:
  """Guess MIME type from file path."""
  import mimetypes as _mt
  guessed = _mt.guess_type(file_path)[0]
  if guessed and guessed.startswith("image/"):
    return guessed
  if file_path.lower().endswith(".webp"):
    return "image/webp"
  return "image/jpeg"


def _resolve_sticker_media(
  media_paths_by_chat: dict,
  payload: dict,
  chat_id: str,
) -> str | None:
  """Find the media file path to use for sticker creation.
  First checks the current payload's attachments; falls back to the
  quoted message's tracked path (populated when the original image arrived).
  """
  atts = payload.get("attachments") or []
  if atts and isinstance(atts[0], dict):
    path = atts[0].get("path")
    if path and os.path.isfile(path):
      return path
  # Fall back to quoted message's previously tracked path
  quoted = payload.get("quoted") or {}
  quoted_ctx_id = quoted.get("contextMsgId")
  if quoted_ctx_id:
    stored = media_paths_by_chat.get(chat_id, {}).get(quoted_ctx_id)
    # stored can be a list of dicts (new format) or single string (legacy)
    if isinstance(stored, list) and stored and isinstance(stored[0], dict):
      path = stored[0].get("path")
      if path and os.path.isfile(path):
        return path
    elif isinstance(stored, str) and os.path.isfile(stored):
      return stored
  return None


def _append_sticker_log_to_history(
  history: deque,
  log_text: str,
) -> None:
  """Append a synthetic assistant entry to the conversation history for sticker creation."""
  history.append(WhatsAppMessage(
    timestamp_ms=int(time.time() * 1000),
    sender=assistant_name(),
    sender_ref=assistant_sender_ref(),
    text=log_text,
    role="assistant",
  ))


async def _dispatch_sticker(
  ws,
  chat_id: str,
  sticker_info: dict,
  reply_to: str | None,
  *,
  request_id: str,
) -> None:
  """Send a sticker using the correct transport based on its type.

  ``sticker_info`` is the dict returned by ``resolve_sticker()``:
    - ``lottie_payload`` set  → relay full Lottie payload via Node (animation preserved)
    - ``file_path`` set       → send regular .webp via send_message/attachment
  """
  lottie_payload = sticker_info.get("lottie_payload")
  file_path = sticker_info.get("file_path")

  if lottie_payload:
    await send_lottie_sticker_payload(
      ws,
      chat_id,
      lottie_payload,
      reply_to,
      request_id=request_id,
    )
  elif file_path:
    await send_sticker(
      ws,
      chat_id,
      file_path,
      reply_to,
      request_id=request_id,
    )
  else:
    logger.warning(
      "_dispatch_sticker: sticker_info has no file_path or lottie_payload chat_id=%s",
      chat_id,
    )


@dataclass
class PendingChat:
  payloads: list[dict] = field(default_factory=list)
  burst_started_at: float | None = None
  last_event_at: float | None = None
  wake_event: asyncio.Event = field(default_factory=asyncio.Event)
  prefix_interrupt: asyncio.Event = field(default_factory=asyncio.Event)
  task: asyncio.Task | None = None
  lock: asyncio.Lock = field(default_factory=asyncio.Lock)


async def _deliver_subagent_result(
  *,
  ws,
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
  finalized_history = subagent_tracker._history.get(chat_id) or []
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
      reply_msg = await generate_reply(
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
    subagent_tracker.clear_history_for_chat(chat_id)

  return redispach_subagent_actions


def _compute_idle_trigger(min_val: int, max_val: int, msg_count: int) -> bool:
  """Pure logic for idle trigger probability. No DB calls."""
  if msg_count < min_val:
    return False
  if min_val == max_val:
    return True
  if msg_count >= max_val:
    return True
  return random.random() < (1.0 / (max_val - msg_count + 1))


async def handle_socket(ws):
  per_chat: Dict[str, Deque[WhatsAppMessage]] = defaultdict(deque)
  per_chat_lock: Dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
  pending_by_chat: Dict[str, PendingChat] = defaultdict(PendingChat)
  pending_send_request_chat: OrderedDict[str, str] = OrderedDict()
  recent_reply_signatures_by_chat: Dict[str, Deque[tuple[int, str]]] = defaultdict(deque)
  media_paths_by_chat: Dict[str, Dict[str, list]] = defaultdict(dict)
  # Staged sub-agent output files awaiting acknowledgement from the gateway.
  # Keyed by ``request_id`` (e.g. ``subagent_attach-1715097600000-000042``).
  # Value is ``(chat_id, file_info_list)`` so the action_ack handler can
  # store file paths into ``media_paths_by_chat`` under their real contextMsgId
  # once the gateway acknowledges the send.
  # Uses OrderedDict for LRU eviction to prevent unbounded growth if acks
  # are lost or delayed.
  pending_subagent_attachments: OrderedDict[str, tuple[str, list[dict]]] = OrderedDict()
  # Tracks `run_command` actions awaiting an action_ack from the gateway.
  # Keyed by ``request_id``; value is ``(chat_id, command_text)`` so the ack
  # handler can append a synthetic "Command X executed successfully" entry to
  # per-chat history. Uses OrderedDict for LRU eviction.
  pending_run_command_chat: OrderedDict[str, tuple[str, str]] = OrderedDict()
  idle_msg_count: Dict[str, int] = defaultdict(int)
  tasks: Set[asyncio.Task] = set()
  logger.info("Gateway connected")

  # Start dashboard flush loop
  dashboard_task = await start_flush_loop()
  tasks.add(dashboard_task)

  def _track_task(task: asyncio.Task) -> None:
    tasks.add(task)
    task.add_done_callback(tasks.discard)

  # Forward sub-agent queue webhooks to WhatsApp. The webhook server
  # closes over this handler; the handler closes over the live ``ws``
  # so it can call ``send_message`` directly. The handler is cleared
  # in the ``finally`` block below when the gateway disconnects so a
  # stale ws is never written to.
  async def _on_subagent_queue_event(
    chat_id: str,
    event_type: str,
    position: int,
    queue_size: int,
  ) -> None:
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

  subagent_webhook.set_queue_handler(_on_subagent_queue_event)

  def _is_duplicate_reply(chat_id: str, text: str | None) -> bool:
    if REPLY_DEDUP_WINDOW_MS <= 0:
      return False

    signature = _reply_signature(text)
    if len(signature) < REPLY_DEDUP_MIN_CHARS:
      return False

    now_ms = int(time.time() * 1000)
    cutoff = now_ms - REPLY_DEDUP_WINDOW_MS
    items = recent_reply_signatures_by_chat[chat_id]
    while items and items[0][0] < cutoff:
      items.popleft()

    if any(prev_sig == signature for _, prev_sig in items):
      return True

    items.append((now_ms, signature))
    while len(items) > 24:
      items.popleft()
    return False

  def _should_idle_trigger(chat_id: str, msg_count: int) -> bool:
    """Check if the idle trigger should fire based on the message count."""
    cfg = db_get_idle_trigger(chat_id)
    if not cfg:
      return False
    min_val, max_val = cfg
    return _compute_idle_trigger(min_val, max_val, msg_count)

  async def process_message_batch(payloads: list[dict]):
    if not payloads:
      return

    _cleanup_stale_media_paths(media_paths_by_chat)

    non_empty_payloads = [payload for payload in payloads if _payload_has_meaningful_content(payload)]
    if not non_empty_payloads:
      chat_id = payloads[-1].get("chatId") if payloads else "unknown"
      logger.debug(
        "skipped empty batch",
        extra={
          "chat_id": chat_id,
          "batch_size": len(payloads),
          "message_ids": [p.get("messageId") for p in payloads],
        },
      )
      return

    # --- Slash command handling ---
    # Commands are now handled by Node.js (commandHandler.js).
    # Python only adds commands to history for context and handles /sticker (PIL) and /reset (memory clear).
    remaining_payloads: list[dict] = []
    for payload in non_empty_payloads:
      _store_media_path(media_paths_by_chat, payload)

      slash_cmd = payload.get("slashCommand")
      cmd_handled = bool(payload.get("commandHandled"))

      if not slash_cmd or not isinstance(slash_cmd, dict):
        remaining_payloads.append(payload)
        continue

      cmd_name = slash_cmd.get("command") or ""
      cmd_args = slash_cmd.get("args") or ""
      p_chat_id = payload.get("chatId") or "unknown"

      # /reset wipes the chat's history and any pending caches. It must run
      # BEFORE the /reset slash message is appended so the marker itself is
      # not preserved as the first turn after the reset, and BEFORE the
      # cmd_handled short-circuit below — Node always sets commandHandled=true
      # for /reset, so the original handler that lived after the skip was
      # dead code. Same-batch user payloads accumulated up to this point are
      # also dropped: those messages preceded the reset boundary, so
      # treating them as "post-reset" history would defeat the point.
      if cmd_name == "reset":
        is_global_reset = cmd_args.strip().lower() == "global"
        if is_global_reset and not payload.get("senderIsOwner"):
          continue
        if is_global_reset:
          per_chat.clear()
          idle_msg_count.clear()
          subagent_tracker.clear_all()
          db_reset_settings_connection()
          logger.info("Memory and caches cleared for ALL chats via /reset global (inline)")
        else:
          per_chat[p_chat_id].clear()
          idle_msg_count.pop(p_chat_id, None)
          subagent_tracker.clear_history_for_chat(p_chat_id)
          db_invalidate_chat_caches(p_chat_id)
          logger.info(
            "Memory and per-chat settings caches cleared for chat_id=%s via /reset",
            p_chat_id,
          )
        remaining_payloads.clear()
        continue

      history = per_chat[p_chat_id]

      # Add command message to history (for LLM context)
      _append_or_merge_history_payload(history, payload)

      # Handle /dump: build full LLM context and send as a .txt attachment
      # (must run before cmd_handled check since Node marks all slash commands as handled)
      if cmd_name == "dump":
        p_group_description, p_db_prompt = _resolve_group_prompt_context(payload)
        p_chat_type, p_bot_is_admin, p_bot_is_super_admin = _chat_state_from_payload(payload)
        p_reply_to = _normalize_context_msg_id(payload.get("contextMsgId"))
        try:
          from .llm.llm2 import _render_system_prompt, _load_system_prompt, _group_description_block, _chat_state_header, _current_date_str
          from .db import get_permission as _get_perm, permission_allows_delete, permission_allows_mute, permission_allows_kick, get_subagent_enabled as _get_subagent
        except ImportError:
          from bridge.llm.llm2 import _render_system_prompt, _load_system_prompt, _group_description_block, _chat_state_header, _current_date_str  # type: ignore
          from bridge.db import get_permission as _get_perm, permission_allows_delete, permission_allows_mute, permission_allows_kick, get_subagent_enabled as _get_subagent  # type: ignore
        p_perm = _get_perm(p_chat_id)
        p_admin_ok = p_bot_is_admin or p_bot_is_super_admin
        p_allow_delete = p_admin_ok and permission_allows_delete(p_perm)
        p_allow_mute = p_admin_ok and permission_allows_mute(p_perm)
        p_allow_kick = p_admin_ok and permission_allows_kick(p_perm)
        p_allow_subagent = _get_subagent(p_chat_id)
        p_rendered_system = _render_system_prompt(
          _load_system_prompt(),
          prompt_override=p_db_prompt,
          allow_delete=p_allow_delete,
          allow_mute=p_allow_mute,
          allow_kick=p_allow_kick,
          allow_subagent=p_allow_subagent,
        )
        p_hist_text = format_history(list(history), history=list(history)) or "(no messages)"
        p_current_msg = _payload_to_message(payload)
        p_current_text = format_history([p_current_msg], history=[p_current_msg])
        p_group_text = _group_description_block(p_group_description)
        p_chat_state = _chat_state_header(p_chat_type, p_bot_is_admin, p_bot_is_super_admin)
        dump_parts = [
          "=== SYSTEM PROMPT ===",
          p_rendered_system,
          "",
          "=== GROUP DESCRIPTION ===",
          p_group_text,
          "",
          "=== CHAT STATE ===",
          p_chat_state,
          "",
          "=== OLDER MESSAGES ===",
          p_hist_text,
          "",
          "=== CURRENT MESSAGE ===",
          p_current_text,
        ]
        dump_text = "\n".join(dump_parts)
        dump_file = None
        try:
          # Write to MEDIA_DIR instead of /tmp to avoid race condition where
          # Node.js tries to read the file after Python deletes it.
          # This follows the same pattern as subagent output staging.
          _media_dir_path = os.getenv("MEDIA_DIR")
          if _media_dir_path:
            _dump_root = os.path.join(_media_dir_path, "dump_context")
          else:
            _dump_root = os.path.join(os.path.dirname(__file__), "..", "..", "data", "media", "dump_context")
          os.makedirs(_dump_root, exist_ok=True)
          _timestamp = int(time.time() * 1000)
          dump_file = os.path.join(_dump_root, f"llm_context_{_timestamp}.txt")
          with open(dump_file, "w", encoding="utf-8") as _f:
            _f.write(dump_text)
          await send_attachment(
            ws, p_chat_id, dump_file, "document",
            request_id=_make_request_id("dump"),
            file_name="llm_context.txt",
            reply_to=p_reply_to,
          )
        except Exception as dump_err:
          logger.exception("dump failed: %s", dump_err, extra={"chat_id": p_chat_id})
          await send_message(
            ws, p_chat_id, f"Failed to generate dump: {dump_err}",
            p_reply_to, request_id=_make_request_id("cmd"),
          )
        continue

      # If command already handled by Node.js, skip further processing
      if cmd_handled:
        logger.debug("command %s handled by gateway, skipping", cmd_name, extra={"chat_id": p_chat_id})
        continue

      # Handle /sticker: create meme-style sticker (requires PIL, stays in Python)
      if cmd_name == "sticker":
        p_chat_type, p_bot_is_admin, _ = _chat_state_from_payload(payload)
        upper_text, lower_text = _parse_sticker_args(cmd_args)
        media_path = _resolve_sticker_media(media_paths_by_chat, payload, p_chat_id)
        reply_to = _normalize_context_msg_id(payload.get("contextMsgId"))
        if not media_path:
          await send_message(
            ws, p_chat_id,
            "Send an image with the `/sticker` caption or reply to an image.",
            reply_to, request_id=_make_request_id("cmd"),
          )
        else:
          try:
            sticker_path = create_sticker_file(media_path, upper_text, lower_text)
            await send_sticker(ws, p_chat_id, sticker_path, reply_to, request_id=_make_request_id("sticker"))
            record_stat(p_chat_id, "stickers_sent")
            log_parts = ["Successfully created sticker"]
            if upper_text:
              log_parts.append(f"upper_text: {upper_text}")
            if lower_text:
              log_parts.append(f"lower_text: {lower_text}")
            if upper_text or lower_text:
              log_parts.append("font_size: 150")
            _append_sticker_log_to_history(history, ", ".join(log_parts))
          except Exception as err:
            logger.exception("sticker creation failed: %s", err, extra={"chat_id": p_chat_id})
            await send_message(
              ws, p_chat_id, f"Failed to create sticker: {err}",
              reply_to, request_id=_make_request_id("cmd"),
            )
        continue

      # All other commands are handled by Node.js, just skip
      logger.debug("command %s not handled in Python, skipping", cmd_name, extra={"chat_id": p_chat_id})
      continue

    non_empty_payloads = remaining_payloads
    if not non_empty_payloads:
      return

    context_only_payloads = [payload for payload in non_empty_payloads if _is_context_only_payload(payload)]
    trigger_indexes = [
      idx for idx, payload in enumerate(non_empty_payloads) if _payload_triggers_llm1(payload)
    ]
    llm1_trigger_payloads = [non_empty_payloads[idx] for idx in trigger_indexes]
    last_trigger_index = trigger_indexes[-1] if trigger_indexes else None
    passive_context_payloads = [
      payload for payload in context_only_payloads if not _payload_triggers_llm1(payload)
    ]

    last_payload = llm1_trigger_payloads[-1] if llm1_trigger_payloads else non_empty_payloads[-1]
    chat_id = last_payload["chatId"]
    history = per_chat[chat_id]
    lock = per_chat_lock[chat_id]
    batch_started = time.perf_counter()
    last_payload_ts = None
    raw_ts = last_payload.get("timestampMs")
    try:
      ts = int(raw_ts)
      last_payload_ts = ts if ts > 0 else None
    except (TypeError, ValueError):
      last_payload_ts = None
    lock_wait_started = time.perf_counter()
    async with lock:
      lock_wait_ms = int((time.perf_counter() - lock_wait_started) * 1000)
      llm1_ms = 0
      llm2_ms = 0
      action_send_ms = 0

      def _log_slow_batch(outcome: str, *, action_counts: dict | None = None, action_total: int = 0):
        total_ms = int((time.perf_counter() - batch_started) * 1000)
        if total_ms < SLOW_BATCH_LOG_MS and lock_wait_ms < SLOW_BATCH_LOG_MS:
          return
        payload_age_ms = None
        if last_payload_ts is not None:
          payload_age_ms = max(0, int(time.time() * 1000) - last_payload_ts)
        logger.info(
          "slow batch observed",
          extra={
            "chat_id": chat_id,
            "outcome": outcome,
            "batch_size": len(payloads),
            "non_empty_batch_size": len(non_empty_payloads),
            "llm1_trigger_batch_size": len(llm1_trigger_payloads),
            "context_only_batch_size": len(context_only_payloads),
            "passive_context_batch_size": len(passive_context_payloads),
            "lock_wait_ms": lock_wait_ms,
            "llm1_ms": llm1_ms,
            "llm2_ms": llm2_ms,
            "action_send_ms": action_send_ms,
            "total_ms": total_ms,
            "payload_age_ms": payload_age_ms,
            "history_len": len(history),
            "last_message_id": last_payload.get("messageId"),
            "last_type": last_payload.get("messageType"),
            "last_sender": last_payload.get("senderName") or last_payload.get("senderId"),
            "action_counts": action_counts,
            "action_total": action_total,
          },
        )

      try:
        logger.debug(
          "incoming_batch",
          extra={
            "chat_id": chat_id,
            "batch_size": len(payloads),
            "non_empty_batch_size": len(non_empty_payloads),
            "llm1_trigger_batch_size": len(llm1_trigger_payloads),
            "context_only_batch_size": len(context_only_payloads),
            "passive_context_batch_size": len(passive_context_payloads),
            "message_ids": [p.get("messageId") for p in non_empty_payloads],
            "last_message_id": last_payload.get("messageId"),
            "type": last_payload.get("messageType"),
            "text": last_payload.get("text"),
            "attachments": len(last_payload.get("attachments") or []),
            "quoted": bool(last_payload.get("quoted")),
            "location": bool(last_payload.get("location")),
            "history_len": len(history),
            "sender": last_payload.get("senderName") or last_payload.get("senderId"),
            "raw_payload": last_payload,
          },
        )
        if not llm1_trigger_payloads:
          for payload in non_empty_payloads:
            _append_or_merge_history_payload(history, payload)
          logger.debug("stored context-only updates", extra={"chat_id": chat_id})
          _log_slow_batch("context_only")
          return

        trigger_window_payloads = non_empty_payloads[: (last_trigger_index + 1)]
        prefix_payloads = trigger_window_payloads[:-1]
        passive_prefix_payloads = [
          payload for payload in prefix_payloads if not _payload_triggers_llm1(payload)
        ]

        history_before_current = list(history)
        current = _build_burst_current(llm1_trigger_payloads)
        llm1_history = list(history_before_current)
        # LLM1 should evaluate the pending window as a single "current" burst
        # so one trailing sticker does not overshadow earlier questions.
        llm1_current = _build_burst_current(trigger_window_payloads)
        llm2_history = list(history_before_current)
        llm2_history.extend(_payload_to_message(payload) for payload in passive_prefix_payloads)
        batch_payload_age_ms = None
        if last_payload_ts is not None:
          batch_payload_age_ms = max(0, int(time.time() * 1000) - last_payload_ts)
        if (
          MAX_TRIGGER_BATCH_AGE_MS > 0
          and batch_payload_age_ms is not None
          and batch_payload_age_ms > MAX_TRIGGER_BATCH_AGE_MS
        ):
          for payload in non_empty_payloads:
            _append_or_merge_history_payload(history, payload)
          logger.info(
            "skipped stale trigger batch",
            extra={
              "chat_id": chat_id,
              "payload_age_ms": batch_payload_age_ms,
              "max_trigger_batch_age_ms": MAX_TRIGGER_BATCH_AGE_MS,
              "trigger_batch_size": len(llm1_trigger_payloads),
            },
          )
          _log_slow_batch("stale_skip")
          return
        group_description, db_prompt = _resolve_group_prompt_context(last_payload)
        chat_type, bot_is_admin, bot_is_super_admin = _chat_state_from_payload(last_payload)
        llm_context_metadata = _build_llm1_context_metadata(
          history_before_current,
          trigger_window_payloads,
        )
        llm1_payload = dict(last_payload)
        llm1_payload.update(llm_context_metadata)

        # --- Dashboard: record messages processed ---
        for _dp in llm1_trigger_payloads:
          record_stat(chat_id, "messages_processed")
          if bool(_dp.get("botMentioned")):
            record_stat(chat_id, "bot_tags")
          _dp_text = _clean_text(_dp.get("text"))
          if _dp_text and assistant_name_pattern().search(_dp_text):
            record_stat(chat_id, "bot_name_mentions")

        # --- Mode-aware LLM1 decision ---
        chat_mode = db_get_mode(chat_id) if chat_type == "group" else "auto"
        triggers = db_get_triggers(chat_id) if chat_mode in ("prefix", "hybrid") else set()

        if chat_type == "private":
          decision = LLM1Decision(
            should_response=True,
            confidence=100,
            reason="Private chat: always respond to direct messages.",
          )
          llm1_ms = 0
          logger.info("private chat; skipping LLM1", extra={"chat_id": chat_id})
        elif chat_mode == "prefix":
          # Prefix mode: check if any trigger payload matches prefix
          prefix_matched_payloads = [p for p in llm1_trigger_payloads if _message_matches_prefix(p, triggers)]
          if not prefix_matched_payloads:
            # No prefix match — check idle trigger before skipping
            idle_msg_count[chat_id] += len(llm1_trigger_payloads)
            if _should_idle_trigger(chat_id, idle_msg_count[chat_id]):
              triggered_count = idle_msg_count[chat_id]
              idle_msg_count[chat_id] = 0
              decision = LLM1Decision(
                should_response=True,
                confidence=100,
                reason="Idle trigger: bot has been silent too long, try to join the conversation.",
              )
              llm1_ms = 0
              logger.info(
                "prefix mode: no match but idle trigger fired",
                extra={"chat_id": chat_id, "idle_count": triggered_count},
              )
            else:
              for payload in non_empty_payloads:
                _append_or_merge_history_payload(history, payload)
              logger.info(
                "prefix mode: no match; skipping",
                extra={"chat_id": chat_id, "triggers": sorted(triggers), "batch_size": len(llm1_trigger_payloads)},
              )
              _log_slow_batch("prefix_no_match")
              return
          else:
            # Prefix matched — skip LLM1, go straight to LLM2
            decision = LLM1Decision(
              should_response=True,
              confidence=100,
              reason="Prefix mode: bot was explicitly invoked.",
            )
            llm1_ms = 0
            # Record invoking user for dashboard
            for _pp in prefix_matched_payloads:
              _pp_ref = _clean_text(_pp.get("senderRef"))
              _pp_name = _clean_text(_pp.get("senderName"))
              if _pp_ref:
                record_user_invoke(chat_id, _pp_ref, _pp_name)
            logger.info(
              "prefix mode: matched %d/%d payloads; skipping LLM1",
              len(prefix_matched_payloads), len(llm1_trigger_payloads),
              extra={"chat_id": chat_id, "triggers": sorted(triggers)},
            )
        elif chat_mode == "hybrid":
          # Hybrid mode: check prefix triggers first, fall back to auto (LLM1)
          prefix_matched_payloads = [p for p in llm1_trigger_payloads if _message_matches_prefix(p, triggers)]
          if prefix_matched_payloads:
            # Prefix matched in current batch — skip LLM1, go straight to LLM2
            decision = LLM1Decision(
              should_response=True,
              confidence=100,
              reason="Hybrid mode: bot was explicitly invoked (prefix trigger in batch).",
            )
            llm1_ms = 0
            for _pp in prefix_matched_payloads:
              _pp_ref = _clean_text(_pp.get("senderRef"))
              _pp_name = _clean_text(_pp.get("senderName"))
              if _pp_ref:
                record_user_invoke(chat_id, _pp_ref, _pp_name)
            logger.info(
              "hybrid mode: prefix matched %d/%d payloads; skipping LLM1",
              len(prefix_matched_payloads), len(llm1_trigger_payloads),
              extra={"chat_id": chat_id, "triggers": sorted(triggers)},
            )
          else:
            # No prefix match in batch — run LLM1 with cancellation support
            pending = pending_by_chat[chat_id]
            pending.prefix_interrupt.clear()
            llm1_started = time.perf_counter()

            llm1_task = asyncio.create_task(call_llm1(
              llm1_history,
              llm1_current,
              current_payload=llm1_payload,
              group_description=group_description,
              prompt_override=db_prompt,
            ))
            interrupt_wait = asyncio.create_task(pending.prefix_interrupt.wait())

            done, _pending_tasks = await asyncio.wait(
              {llm1_task, interrupt_wait},
              return_when=asyncio.FIRST_COMPLETED,
            )

            if interrupt_wait in done:
              # Prefix trigger arrived while LLM1 was running — cancel LLM1
              llm1_task.cancel()
              try:
                await llm1_task
              except (asyncio.CancelledError, Exception):
                pass
              llm1_ms = int((time.perf_counter() - llm1_started) * 1000)

              # Drain new prefix-trigger payloads from pending
              async with pending.lock:
                new_payloads = list(pending.payloads)
                pending.payloads.clear()
                pending.burst_started_at = None
                pending.last_event_at = None
                pending.prefix_interrupt.clear()

              if new_payloads:
                # Merge new payloads into current batch for LLM2
                non_empty_payloads.extend(new_payloads)
                new_trigger_payloads = [p for p in new_payloads if _payload_triggers_llm1(p)]
                llm1_trigger_payloads.extend(new_trigger_payloads)
                # Rebuild burst context for LLM2 with merged payloads
                trigger_window_payloads = list(non_empty_payloads)
                current = _build_burst_current(llm1_trigger_payloads)

              decision = LLM1Decision(
                should_response=True,
                confidence=100,
                reason="Hybrid mode: prefix trigger interrupted LLM1; responding immediately.",
              )
              # Record invoking users from new payloads
              for _np in new_payloads:
                if _message_matches_prefix(_np, triggers):
                  _np_ref = _clean_text(_np.get("senderRef"))
                  _np_name = _clean_text(_np.get("senderName"))
                  if _np_ref:
                    record_user_invoke(chat_id, _np_ref, _np_name)
              logger.info(
                "hybrid mode: prefix trigger interrupted LLM1 after %dms; merged %d new payloads",
                llm1_ms, len(new_payloads),
                extra={"chat_id": chat_id, "triggers": sorted(triggers)},
              )
            else:
              # LLM1 finished before any prefix interrupt
              interrupt_wait.cancel()
              try:
                await interrupt_wait
              except (asyncio.CancelledError, Exception):
                pass
              decision = llm1_task.result()
              llm1_ms = int((time.perf_counter() - llm1_started) * 1000)
              record_stat(chat_id, "llm1_calls")
              if decision.input_tokens:
                record_stat(chat_id, "llm1_input_tokens", decision.input_tokens)
              if decision.output_tokens:
                record_stat(chat_id, "llm1_output_tokens", decision.output_tokens)
              if decision.should_response:
                for _ap in llm1_trigger_payloads:
                  _ap_ref = _clean_text(_ap.get("senderRef"))
                  _ap_name = _clean_text(_ap.get("senderName"))
                  if _ap_ref:
                    record_user_invoke(chat_id, _ap_ref, _ap_name)
              logger.info(
                "hybrid mode: LLM1 completed in %dms (no prefix interrupt); should_response=%s",
                llm1_ms, decision.should_response,
                extra={"chat_id": chat_id, "confidence": decision.confidence},
              )
        else:
          llm1_started = time.perf_counter()
          decision = await call_llm1(
            llm1_history,
            llm1_current,
            current_payload=llm1_payload,
            group_description=group_description,
            prompt_override=db_prompt,
          )
          llm1_ms = int((time.perf_counter() - llm1_started) * 1000)
          record_stat(chat_id, "llm1_calls")
          if decision.input_tokens:
            record_stat(chat_id, "llm1_input_tokens", decision.input_tokens)
          if decision.output_tokens:
            record_stat(chat_id, "llm1_output_tokens", decision.output_tokens)
          # Record invoking user for auto mode too
          if decision.should_response:
            for _ap in llm1_trigger_payloads:
              _ap_ref = _clean_text(_ap.get("senderRef"))
              _ap_name = _clean_text(_ap.get("senderName"))
              if _ap_ref:
                record_user_invoke(chat_id, _ap_ref, _ap_name)

        # Send read receipt after LLM1 processes (regardless of decision)
        for _p in trigger_window_payloads:
          _msg_id = _p.get("messageId")
          _participant = _p.get("senderId") if _p.get("isGroup") else None
          await send_mark_read(ws, chat_id, _msg_id, _participant)

        for payload in non_empty_payloads:
          _append_or_merge_history_payload(history, payload)
        # Handle express decision from LLM1 (skip LLM2 entirely)
        if decision.react_expression and decision.react_context_msg_id:
          sticker_info = resolve_sticker(decision.react_expression, chat_id=chat_id)
          if sticker_info:
            logger.info(
              "llm1 express; sending sticker directly (skipping llm2)",
              extra={
                "chat_id": chat_id,
                "sticker_name": decision.react_expression,
                "react_context_msg_id": decision.react_context_msg_id,
                "confidence": decision.confidence,
                "reason": decision.reason,
                "llm1_ms": llm1_ms,
              },
            )
            await _dispatch_sticker(
              ws,
              chat_id,
              sticker_info,
              decision.react_context_msg_id,
              request_id=_make_request_id("sticker"),
            )
            record_stat(chat_id, "stickers_sent")
          else:
            logger.info(
              "llm1 express; sending emoji react directly (skipping llm2)",
              extra={
                "chat_id": chat_id,
                "react_expression": decision.react_expression,
                "react_context_msg_id": decision.react_context_msg_id,
                "confidence": decision.confidence,
                "reason": decision.reason,
                "llm1_ms": llm1_ms,
              },
            )
            await send_react_message(
              ws,
              chat_id,
              decision.react_context_msg_id,
              decision.react_expression,
              request_id=_make_request_id("react"),
            )
          idle_msg_count[chat_id] = 0
          _log_slow_batch("llm1_express")
          return

        if not decision.should_response:
          idle_msg_count[chat_id] += len(llm1_trigger_payloads)
          if _should_idle_trigger(chat_id, idle_msg_count[chat_id]):
            triggered_count = idle_msg_count[chat_id]
            idle_msg_count[chat_id] = 0
            decision = LLM1Decision(
              should_response=True,
              confidence=100,
              reason="Idle trigger: bot has been silent too long, try to join the conversation.",
            )
            logger.info(
              "llm1 skip overridden by idle trigger",
              extra={"chat_id": chat_id, "idle_count": triggered_count},
            )
          else:
            logger.info(
              "llm1 skip; no response sent",
              extra={"chat_id": chat_id},
            )
            _log_slow_batch("llm1_skip")
            return

        allowed_context_ids = _collect_context_ids(history)
        fallback_reply_to = _normalize_context_msg_id(last_payload.get("contextMsgId"))
        llm2_payload = _merge_payload_attachments(trigger_window_payloads, last_payload)
        llm2_payload.update(llm_context_metadata)
        llm2_payload.update(
          {
            "llm1ShouldResponse": decision.should_response,
            "llm1Confidence": decision.confidence,
            "llm1Reason": " ".join((decision.reason or "").split()),
          }
        )

        # Resolve quoted message media for vision-capable models
        resolved_atts = _resolve_quoted_media_attachments(media_paths_by_chat, llm2_payload, chat_id)
        if resolved_atts != (llm2_payload.get("attachments") or []):
          llm2_payload["attachments"] = resolved_atts

        # Determine whether subagent tool should be available for this chat
        allow_subagent = db_get_subagent_enabled(chat_id)
        logger.info(
          "subagent gate: chat_id=%s allow_subagent=%s (execute_subtask tool will be %s LLM2)",
          chat_id,
          allow_subagent,
          "added to" if allow_subagent else "withheld from",
        )

        # Sub-agent context is now passed to generate_reply as a separate
        # prompt slot (msg #4) instead of being smuggled into history as a
        # role=system message. This makes the "task sub-agent" block visible
        # to LLM2 as a standalone instruction rather than a regular history
        # line that format_history flattens out.
        #
        # Three-tier fallback:
        #   1. active  — a task is currently running for this chat
        #   2. recently finished — a task finished within the last 5 min
        #   3. idle   — no task running or recently finished; explicit signal
        #               that execute_subtask is available for new tasks
        subagent_context: str | None = None
        if allow_subagent:
          subagent_context = subagent_tracker.format_context(chat_id)
          if subagent_context is None:
            subagent_context = subagent_tracker.format_recent_finished(chat_id)
          if subagent_context is None:
            subagent_context = subagent_tracker.format_idle(chat_id)

        # NOTE: an "Available files" / file catalogue used to be injected
        # here, but it was unused — LLM2 references attachments by their
        # 6-digit ``contextMsgId`` (which is already in the rendered
        # history), so the path-based catalogue only chewed through the
        # context window without changing model behaviour. The
        # ``execute_subtask`` tool resolves contextMsgIds to file paths
        # automatically on the bridge side, so the model never needs to
        # see the raw paths.

        # Keep typing indicator alive while LLM2 generates (refreshes every 8s)
        llm2_started = time.perf_counter()
        async with typing_indicator(ws, chat_id):
          def _validate_llm2_result(result) -> bool:
            """Return True if the LLM2 output contains at least one usable action."""
            tool_calls = getattr(result, 'tool_calls', None) or []
            if tool_calls:
              test_actions = _extract_actions_from_tool_calls(
                tool_calls,
                fallback_reply_to=fallback_reply_to,
                allowed_context_ids=allowed_context_ids,
              )
              return len(test_actions) > 0
            # Fallback: parse text content (legacy)
            test_actions = _extract_actions(
              result,
              fallback_reply_to=fallback_reply_to,
              allowed_context_ids=allowed_context_ids,
            )
            return len(test_actions) > 0

          reply_msg = await generate_reply(
            llm2_history,
            current,
            current_payload=llm2_payload,
            group_description=group_description,
            prompt_override=db_prompt,
            chat_type=chat_type,
            bot_is_admin=bot_is_admin,
            bot_is_super_admin=bot_is_super_admin,
            result_validator=_validate_llm2_result,
            allow_subagent=allow_subagent,
            subagent_context=subagent_context,
          )

        llm2_ms = int((time.perf_counter() - llm2_started) * 1000)
        record_stat(chat_id, "llm2_calls")
        # Track LLM2 token usage if available
        if reply_msg is not None:
          _usage = getattr(reply_msg, "usage_metadata", None)
          if isinstance(_usage, dict):
            _in_tok = _usage.get("input_tokens", 0)
            _out_tok = _usage.get("output_tokens", 0)
            if _in_tok:
              record_stat(chat_id, "llm2_input_tokens", _in_tok)
            if _out_tok:
              record_stat(chat_id, "llm2_output_tokens", _out_tok)
        if reply_msg is None:
          record_stat(chat_id, "errors")
          logger.warning("llm2 failed to produce reply", extra={"chat_id": chat_id})
          idle_msg_count[chat_id] += len(llm1_trigger_payloads)
          if _should_idle_trigger(chat_id, idle_msg_count[chat_id]):
            triggered_count = idle_msg_count[chat_id]
            idle_msg_count[chat_id] = 0
            logger.info(
              "idle trigger fired after llm2 failure",
              extra={"chat_id": chat_id, "idle_count": triggered_count},
            )
            # Counter drained: next batch starts fresh. We intentionally do not
            # retry LLM2 here to avoid an infinite retry loop on persistent errors.
            # The idle trigger's purpose here is to prevent the counter from
            # indefinitely accumulating past max_val through a failure storm.
          _log_slow_batch("llm2_none")
          return
        idle_msg_count[chat_id] = 0
        tool_calls = getattr(reply_msg, 'tool_calls', None) or []
        if tool_calls:
          actions = _extract_actions_from_tool_calls(
            tool_calls,
            fallback_reply_to=fallback_reply_to,
            allowed_context_ids=allowed_context_ids,
          )
        else:
          # Fallback: parse text content (legacy)
          actions = _extract_actions(
            reply_msg,
            fallback_reply_to=fallback_reply_to,
            allowed_context_ids=allowed_context_ids,
          )
        if not actions:
          logger.warning(
            "llm2 returned no executable action",
            extra={
              "chat_id": chat_id,
              "reply_preview": _extract_reply_text(reply_msg),
              "fallback_reply_to": fallback_reply_to,
              "tool_calls": len(tool_calls),
            },
          )
          _log_slow_batch("no_action")
          return

        action_counts: dict[str, int] = defaultdict(int)
        action_send_started = time.perf_counter()
        for action in actions:
          action_type = action.get("type")
          if action_type == "send_message":
            action_text = action.get("text") or ""
            if _is_duplicate_reply(chat_id, action_text):
              logger.info(
                "dropped duplicate reply",
                extra={
                  "chat_id": chat_id,
                  "reply_preview": _normalize_preview_text(action_text, limit=180),
                  "reply_dedup_window_ms": REPLY_DEDUP_WINDOW_MS,
                },
              )
              continue
            request_id = _make_request_id("send")
            await send_message(
              ws,
              chat_id,
              action_text,
              action.get("replyTo"),
              request_id=request_id,
            )
            record_stat(chat_id, "responses_sent")
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
              text=action_text or None,
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
            hydrate_quoted_from_history(_prov_msg, history)
            _append_history(
              history,
              _prov_msg,
            )
            # Auto-detect fenced code blocks in the reply text and send a
            # cta_copy interactive message so the user can tap to copy the
            # code.  Only the first code block is used as the copy payload.
            # The original text message is sent unmodified above — this is
            # a separate follow-up bubble that quotes a dummy message with
            # the code snippet as the quoted preview text.
            _code = extract_first_code_block(action_text)
            if _code:
              await send_copy_code(
                ws,
                chat_id,
                _code,
                quoted_preview_text=_normalize_preview_text(_code, limit=120),
                request_id=_make_request_id("copy"),
              )
            action_counts[action_type] += 1
            continue
          if action_type == "delete_message":
            await send_delete_message(
              ws,
              chat_id,
              action.get("contextMsgId"),
              request_id=_make_request_id("delete"),
            )
            action_counts[action_type] += 1
            continue
          if action_type == "kick_member":
            await send_kick_member(
              ws,
              chat_id,
              action.get("targets") or [],
              request_id=_make_request_id("kick"),
              mode=action.get("mode") or "partial_success",
              auto_reply_anchor=bool(action.get("autoReplyAnchor", False)),
            )
            action_counts[action_type] += 1
            continue
          if action_type == "react_message":
            await send_react_message(
              ws,
              chat_id,
              action.get("contextMsgId"),
              action.get("emoji"),
              request_id=_make_request_id("react"),
            )
            action_counts[action_type] += 1
            continue
          if action_type == "express_message":
            expression = str(action.get("expression") or "").strip()
            if not expression:
              continue
            sticker_info = resolve_sticker(expression, chat_id=chat_id)
            if sticker_info:
              request_id = _make_request_id("sticker")
              await _dispatch_sticker(
                ws,
                chat_id,
                sticker_info,
                action.get("contextMsgId"),
                request_id=request_id,
              )
              record_stat(chat_id, "stickers_sent")
              # Add history entry so LLM knows which sticker was sent
              _sticker_prov_msg = WhatsAppMessage(
                timestamp_ms=int(time.time() * 1000),
                sender=assistant_name(),
                context_msg_id="pending",
                sender_ref=assistant_sender_ref(),
                sender_is_admin=False,
                text=f"<media:sticker={expression}>",
                media="sticker",
                quoted_message_id=_normalize_context_msg_id(action.get("contextMsgId")),
                quoted_sender=None,
                quoted_text=None,
                quoted_media=None,
                quoted_sender_ref=None,
                quoted_sender_is_admin=False,
                quoted_sender_is_super_admin=False,
                message_id=f"local-sticker-{request_id}",
                role="assistant",
              )
              hydrate_quoted_from_history(_sticker_prov_msg, history)
              _append_history(history, _sticker_prov_msg)
            else:
              await send_react_message(
                ws,
                chat_id,
                action.get("contextMsgId"),
                expression,
                request_id=_make_request_id("react"),
              )
            action_counts[action_type] += 1
            continue
          if action_type == "send_sticker":
            sticker_name = action.get("stickerName", "")
            sticker_info = resolve_sticker(sticker_name, chat_id=chat_id)
            if sticker_info:
              request_id = _make_request_id("sticker")
              await _dispatch_sticker(
                ws,
                chat_id,
                sticker_info,
                action.get("replyTo"),
                request_id=request_id,
              )
              record_stat(chat_id, "stickers_sent")
              # Add history entry so LLM knows which sticker was sent
              _sticker_prov_msg = WhatsAppMessage(
                timestamp_ms=int(time.time() * 1000),
                sender=assistant_name(),
                context_msg_id="pending",
                sender_ref=assistant_sender_ref(),
                sender_is_admin=False,
                text=f"<media:sticker={sticker_name}>",
                media="sticker",
                quoted_message_id=_normalize_context_msg_id(action.get("replyTo")),
                quoted_sender=None,
                quoted_text=None,
                quoted_media=None,
                quoted_sender_ref=None,
                quoted_sender_is_admin=False,
                quoted_sender_is_super_admin=False,
                message_id=f"local-sticker-{request_id}",
                role="assistant",
              )
              hydrate_quoted_from_history(_sticker_prov_msg, history)
              _append_history(history, _sticker_prov_msg)
              action_counts[action_type] += 1
            else:
              logger.warning(
                "sticker not found: %s",
                sticker_name,
                extra={"chat_id": chat_id},
              )
            continue
          if action_type == "send_quiz":
            request_id = _make_request_id("quiz")
            await send_quiz(
              ws,
              chat_id,
              action.get("question", ""),
              action.get("choices", []),
              request_id=request_id,
              reply_to=action.get("replyTo"),
              footer=action.get("footer"),
            )
            # Add compact history entry so LLM knows a quiz was sent
            _quiz_choices = action.get("choices", [])
            _choice_summary = " | ".join(
              f"{ch['label']}. {ch['text']}" for ch in _quiz_choices
            )
            _quiz_history_text = (
              f"[QUESTION SENT]\n"
              f"{action.get('question', '')}\n"
              f"[BUTTONS] {_choice_summary}"
            )
            _prov_quiz_msg = WhatsAppMessage(
              timestamp_ms=int(time.time() * 1000),
              sender=assistant_name(),
              context_msg_id="pending",
              sender_ref=assistant_sender_ref(),
              sender_is_admin=False,
              text=_quiz_history_text,
              media=None,
              quoted_message_id=_normalize_context_msg_id(action.get("replyTo")),
              quoted_sender=None,
              quoted_text=None,
              quoted_media=None,
              quoted_sender_ref=None,
              quoted_sender_is_admin=False,
              quoted_sender_is_super_admin=False,
              message_id=f"local-quiz-{request_id}",
              role="assistant",
            )
            hydrate_quoted_from_history(_prov_quiz_msg, history)
            _append_history(history, _prov_quiz_msg)
            record_stat(chat_id, "responses_sent")
            action_counts[action_type] += 1
            continue
          if action_type == "mute_member":
            sender_ref = action.get("senderRef", "")
            anchor_id = action.get("anchorContextMsgId")
            duration = action.get("durationMinutes", 30)
            if duration == 0:
              db_remove_mute(chat_id, sender_ref)
            else:
              db_add_mute(chat_id, sender_ref, duration)
              # Delete the anchor message immediately
              if anchor_id:
                await send_delete_message(
                  ws,
                  chat_id,
                  anchor_id,
                  request_id=_make_request_id("mute_del"),
                )
            action_counts[action_type] += 1
            continue
          if action_type == "execute_subtask":
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
              action_counts[action_type] += 1
              continue

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
                        record_stat(chat_id, "responses_sent")
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
            action_counts[action_type] += 1
            continue
          if action_type == "run_command":
            command_text = str(action.get("command") or "").strip()
            if not command_text:
              continue
            request_id = _make_request_id("cmd")
            await send_run_command(
              ws,
              chat_id,
              command_text,
              action.get("contextMsgId"),
              request_id=request_id,
            )
            # Track this request so the action_ack handler can append the
            # corresponding "Command X executed successfully/failed" log
            # line into per-chat history once Node confirms execution.
            pending_run_command_chat[request_id] = (chat_id, command_text)
            pending_run_command_chat.move_to_end(request_id)
            while len(pending_run_command_chat) > 4096:
              pending_run_command_chat.popitem(last=False)
            action_counts[action_type] += 1
            continue
          logger.warning(
            "unknown action type from parser: %s",
            action_type,
            extra={"chat_id": chat_id},
          )
        action_send_ms = int((time.perf_counter() - action_send_started) * 1000)
        logger.info(
          "executed actions",
          extra={
            "chat_id": chat_id,
            "action_counts": action_counts,
            "batch_size": len(llm1_trigger_payloads),
            "action_total": len(actions),
          },
        )
        _log_slow_batch("actions_executed", action_counts=action_counts, action_total=len(actions))
      except Exception as err:
        _log_slow_batch("handler_error")
        logger.exception("handler error: %s", err, extra={"chat_id": chat_id})

  async def flush_pending(chat_id: str):
    pending = pending_by_chat[chat_id]
    while True:
      async with pending.lock:
        if not pending.payloads:
          pending.task = None
          return

        now = time.monotonic()
        last_event_at = pending.last_event_at or now
        burst_started_at = pending.burst_started_at or now

        # Skip debounce for private chats and prefix/hybrid mode matches.
        _skip_debounce = False
        _last_p = pending.payloads[-1] if pending.payloads else {}
        _flush_chat_type, _, _ = _chat_state_from_payload(_last_p)
        if _flush_chat_type == "private":
          _skip_debounce = True
        elif db_get_mode(chat_id) in ("prefix", "hybrid"):
          _flush_triggers = db_get_triggers(chat_id)
          for _fp in pending.payloads:
            if _message_matches_prefix(_fp, _flush_triggers):
              _skip_debounce = True
              break

        if _skip_debounce:
          timeout_s = 0.0
        else:
          quiet_deadline = last_event_at + INCOMING_DEBOUNCE_SECONDS
          hard_deadline = burst_started_at + INCOMING_BURST_MAX_SECONDS
          timeout_s = max(0.0, min(quiet_deadline, hard_deadline) - now)
        pending.wake_event.clear()
        wake_event = pending.wake_event

      try:
        await asyncio.wait_for(wake_event.wait(), timeout=timeout_s)
        continue
      except asyncio.TimeoutError:
        pass

      async with pending.lock:
        payloads = list(pending.payloads)
        pending.payloads.clear()
        pending.burst_started_at = None
        pending.last_event_at = None

      if payloads:
        context_payload = payloads[-1] if payloads else {}
        context_chat_type, _, _ = _chat_state_from_payload(context_payload)
        context_chat_name = _clean_text(context_payload.get("chatName")) if context_chat_type == "group" else None
        context_token = set_chat_log_context(
          chat_id=_clean_text(context_payload.get("chatId")) or None,
          chat_name=context_chat_name or None,
        )
        try:
          await process_message_batch(payloads)
        finally:
          reset_chat_log_context(context_token)
      # Keep the same worker task alive so new payloads for the same chat
      # are drained sequentially without spawning extra waiters.

  try:
    async for raw in ws:
      try:
        event = json.loads(raw)
      except json.JSONDecodeError:
        logger.warning("Dropping non-JSON payload")
        continue

      event_type = event.get("type")

      if event_type == "hello":
        logger.info("Handshake: %s", event.get("payload"))
        continue

      if event_type in {"send_ack", "action_ack"}:
        payload = event.get("payload")
        if (
          event_type == "action_ack"
          and isinstance(payload, dict)
          and str(payload.get("action") or "") == "send_message"
        ):
          request_id = _clean_text(payload.get("requestId"))
          chat_id_for_request = pending_send_request_chat.pop(request_id, None)
          # Hydrate provisional history entry for main text sends.
          # Only runs when the request was tracked in pending_send_request_chat
          # (i.e. regular LLM2 text responses).
          if request_id and chat_id_for_request:
            # Extract the primary context msg id (prefers text entries)
            # to hydrate the provisional history entry.
            context_msg_id = _extract_send_ack_context_msg_id(payload)
            if context_msg_id:
              history = per_chat[chat_id_for_request]
              lock = per_chat_lock[chat_id_for_request]
              async with lock:
                updated = _hydrate_provisional_context_id_from_ack(
                  history,
                  request_id=request_id,
                  context_msg_id=context_msg_id,
                )
              if updated:
                logger.debug(
                  "hydrated provisional send context id from action_ack",
                  extra={
                    "chat_id": chat_id_for_request,
                    "request_id": request_id,
                    "context_msg_id": context_msg_id,
                  },
                )
              else:
                logger.debug(
                  "action_ack arrived but provisional send not found",
                  extra={
                    "chat_id": chat_id_for_request,
                    "request_id": request_id,
                    "context_msg_id": context_msg_id,
                  },
                )
          # For sub-agent attachment sends, store the file paths in
          # media_paths_by_chat under their real contextMsgId so that
          # subsequent execute_subtask calls can resolve them.
          # This block must be outside the pending_send_request_chat check
          # because sub-agent attachments are tracked in
          # pending_subagent_attachments, not pending_send_request_chat.
          pending_attach_entry = pending_subagent_attachments.pop(request_id, None)
          if pending_attach_entry is not None:
            attach_chat_id, attach_files = pending_attach_entry
            all_entries = _extract_all_send_ack_entries(payload)
            # Match entries 1:1 with the staged file infos we registered.
            # The ack ``result.sent`` array preserves send order, which
            # matches the order of our pending list.
            for idx, entry in enumerate(all_entries):
              entry_ctx_id = _normalize_context_msg_id(entry.get("contextMsgId"))
              if not entry_ctx_id:
                continue
              if idx < len(attach_files):
                file_info = attach_files[idx]
              else:
                # More ack entries than pending files — shouldn't
                # happen, but handle gracefully.
                break
              media_paths_by_chat.setdefault(attach_chat_id, {})[entry_ctx_id] = [{
                **file_info,
                "received_at": time.time(),
              }]
            # Hydrate the provisional history entry for the attachment
            # so its context_msg_id changes from "pending" to the real ID.
            if request_id:
              context_msg_id = _extract_send_ack_context_msg_id(payload)
              if context_msg_id:
                history = per_chat[attach_chat_id]
                lock = per_chat_lock[attach_chat_id]
                async with lock:
                  _hydrate_provisional_context_id_from_ack(
                    history,
                    request_id=request_id,
                    context_msg_id=context_msg_id,
                  )
            logger.debug(
              "stored subagent attachment paths in media_paths_by_chat",
              extra={
                "chat_id": attach_chat_id,
                "request_id": request_id,
                "entries": len(all_entries),
                "files": len(attach_files),
              },
            )
        # Handle run_command acks: append a synthetic
        # "Command X executed successfully/failed" entry to per-chat
        # history so the LLM sees the outcome on its next turn (this is
        # how it learns its silent /sticker, /help, /owner-contact, etc.
        # actually fired). Using the same _append_sticker_log_to_history
        # helper keeps the entry shape consistent with the existing
        # /sticker note that the inline command handler emits.
        if (
          event_type == "action_ack"
          and isinstance(payload, dict)
          and str(payload.get("action") or "") == "run_command"
        ):
          rc_request_id = _clean_text(payload.get("requestId"))
          rc_entry = pending_run_command_chat.pop(rc_request_id, None) if rc_request_id else None
          if rc_entry is not None:
            rc_chat_id, rc_command_text = rc_entry
            ok = bool(payload.get("ok"))
            # Strip leading slash and grab the canonical command name
            # from the result if Node provided one, otherwise infer from
            # the command text. Node's parseSlashCommand already
            # canonicalises aliases (settings -> setting, etc.).
            result = payload.get("result") if isinstance(payload.get("result"), dict) else {}
            cmd_name = (
              str(result.get("command") or "").strip().lower()
              or rc_command_text.lstrip("/").split(maxsplit=1)[0].lower()
            )
            if ok:
              log_text = f"Command {cmd_name} executed successfully"
            else:
              detail = str(payload.get("detail") or "unknown error").strip()
              log_text = f"Command {cmd_name} failed: {detail}"
            history = per_chat[rc_chat_id]
            lock = per_chat_lock[rc_chat_id]
            async with lock:
              _append_sticker_log_to_history(history, log_text)
            logger.info(
              "run_command ack",
              extra={
                "chat_id": rc_chat_id,
                "request_id": rc_request_id,
                "command": cmd_name,
                "ok": ok,
              },
            )
        logger.debug("Gateway ack: %s", event.get("payload"))
        continue

      if event_type == "error":
        logger.warning("Gateway error: %s", event.get("payload"))
        continue

      # Handle clear_history message from Node.js (after /reset). Node sends
      # this in addition to the /reset slash message itself; the inline
      # /reset handler in process_message_batch is the authoritative path,
      # but this hook still fires immediately so a follow-up message landing
      # before the debounce window expires can't see stale history.
      if event_type == "clear_history":
        clear_chat_id = event.get("chatId")
        if clear_chat_id == "global":
          per_chat.clear()
          idle_msg_count.clear()
          subagent_tracker.clear_all()
          db_reset_settings_connection()
          logger.info("History and caches cleared for ALL chats via clear_history message")
        elif clear_chat_id:
          per_chat[clear_chat_id].clear()
          idle_msg_count.pop(clear_chat_id, None)
          subagent_tracker.clear_history_for_chat(clear_chat_id)
          db_invalidate_chat_caches(clear_chat_id)
          logger.info("History cleared for chat_id=%s via clear_history message", clear_chat_id)
        continue

      # Handle invalidate_llm2_model message from Node.js (after model change)
      if event_type == "invalidate_llm2_model":
        clear_chat_id = event.get("chatId")
        if clear_chat_id == "global":
          db_reset_settings_connection()
          logger.info("LLM2 model cache cleared for ALL chats via invalidate_llm2_model message")
        else:
          db_clear_llm2_model_cache(clear_chat_id)
          logger.info("LLM2 model cache cleared for chat_id=%s via invalidate_llm2_model message", clear_chat_id)
        continue

      # Handle set_llm2_model message from Node.js (authoritative sync)
      if event_type == "set_llm2_model":
        chat_id = event.get("chatId")
        model_id = event.get("modelId")
        if chat_id == "global":
          db_reset_settings_connection()
          logger.info("LLM2 model set globally via set_llm2_model message model_id=%s", model_id)
        elif chat_id:
          db_set_llm2_model(chat_id, model_id)
          logger.info("LLM2 model set via set_llm2_model message chat_id=%s model_id=%s", chat_id, model_id)
        continue

      # Handle invalidate_default_model message from Node.js (after modelcfg changes)
      if event_type == "invalidate_default_model":
        db_reset_settings_connection()
        logger.info("Settings DB connection reset and caches cleared via invalidate_default_model message")
        continue

      # Handle set_subagent_enabled from Node.js (after /subagent on|off) so
      # the in-process cache (`_subagent_enabled_cache`) is dropped without
      # requiring a bridge restart. The new value will be re-read from
      # chat_settings.subagent_enabled on the next get_subagent_enabled call.
      if event_type == "set_subagent_enabled":
        chat_id = event.get("chatId")
        enabled = bool(event.get("enabled"))
        if chat_id == "global":
          db_reset_settings_connection()
          logger.info("subagent_enabled cache invalidated GLOBALLY")
        elif chat_id:
          db_clear_subagent_enabled_cache(chat_id)
          # Reset the settings DB connection too so SQLite re-reads the row
          # Node just wrote; without this, the cached connection may serve
          # the pre-write snapshot for the lifetime of the process.
          db_reset_settings_connection()
          logger.info(
            "subagent_enabled cache invalidated chat_id=%s enabled=%s",
            chat_id,
            enabled,
          )
        continue

      # Handle invalidate_chat_settings from Node.js (after /mode, /prompt,
      # /permission, /trigger). Without this hook the bridge keeps serving
      # the pre-write cached value (mode/prompt/permission/triggers) until
      # the Python process is restarted, which is exactly the symptom users
      # report as "settings change doesn't take effect until restart".
      if event_type == "invalidate_chat_settings":
        chat_id = event.get("chatId")
        if chat_id == "global":
          db_reset_settings_connection()
          logger.info("chat settings caches invalidated GLOBALLY")
        elif chat_id:
          db_invalidate_chat_caches(chat_id)
          logger.info(
            "chat settings caches invalidated chat_id=%s",
            chat_id,
          )
        continue

      if event_type != "incoming_message":
        continue

      payload = event["payload"]
      chat_id = payload.get("chatId")
      if not chat_id:
        logger.warning("Dropping incoming_message without chatId")
        continue

      # --- Mute enforcement (before debounce, instant) ---
      _mute_sender_ref = (payload.get("senderRef") or "").strip().lower()
      _mute_context_only = bool(payload.get("contextOnly"))
      _mute_msg_type = str(payload.get("messageType") or "").strip().lower()
      if (
        _mute_sender_ref
        and not _mute_context_only
        and _mute_msg_type not in ("groupparticipantsupdate", "actionlog", "botrolechange")
        and db_is_muted(chat_id, _mute_sender_ref)
      ):
        _mute_ctx_id = payload.get("contextMsgId")
        if _mute_ctx_id:
          await send_delete_message(
            ws,
            chat_id,
            _mute_ctx_id,
            request_id=_make_request_id("mute_enforce"),
          )
        # First-delete notification
        if not db_is_mute_notified(chat_id, _mute_sender_ref):
          db_mark_mute_notified(chat_id, _mute_sender_ref)
          _remaining = db_get_mute_remaining(chat_id, _mute_sender_ref)
          _mute_name = payload.get("senderName") or _mute_sender_ref
          await send_message(
            ws,
            chat_id,
            f"Message from {_mute_name} deleted (muted, {_remaining}m remaining).",
            None,
            request_id=_make_request_id("mute_notify"),
          )
        logger.debug(
          "mute enforcement: deleted message from muted user",
          extra={"chat_id": chat_id, "sender_ref": _mute_sender_ref},
        )
        continue  # skip all further processing

      # --- Activation gate (safety net, primary gate is in Node.js) ---
      if REQUIRE_ACTIVATION:
        _act_sender_is_owner = bool(payload.get("senderIsOwner"))
        _act_chat_type = str(payload.get("chatType") or "").strip().lower()
        if not _act_sender_is_owner and not db_is_chat_activated(chat_id):
          logger.debug(
            "activation gate: dropping message from unactivated chat",
            extra={"chat_id": chat_id},
          )
          continue

      # --- Bot role change (promote/demote) handling ---
      if _mute_msg_type == "botrolechange":
        _role_action = (payload.get("groupEvent") or {}).get("action", "")
        if _role_action == "promote":
          await send_message(
            ws,
            chat_id,
            "Bot is now an admin! Moderation features (`/permission`) can now be enabled by group admins.",
            None,
            request_id=_make_request_id("role_notify"),
          )
          logger.info("bot promoted in chat_id=%s", chat_id)
        elif _role_action == "demote":
          db_set_permission(chat_id, 0)
          db_clear_mutes(chat_id)
          await send_message(
            ws,
            chat_id,
            "Bot is no longer an admin. Moderation permissions have been reset to 0 (disabled).",
            None,
            request_id=_make_request_id("role_notify"),
          )
          logger.info("bot demoted in chat_id=%s; permission reset to 0", chat_id)
        continue

      pending = pending_by_chat[chat_id]
      now = time.monotonic()
      async with pending.lock:
        if pending.burst_started_at is None:
          pending.burst_started_at = now
        pending.last_event_at = now
        pending.payloads.append(payload)
        # Signal hybrid mode: if a prefix trigger arrives while LLM1 is running
        if db_get_mode(chat_id) == "hybrid":
          _hybrid_triggers = db_get_triggers(chat_id)
          if _message_matches_prefix(payload, _hybrid_triggers):
            pending.prefix_interrupt.set()
        if pending.task is None or pending.task.done():
          task = asyncio.create_task(flush_pending(chat_id))
          pending.task = task
          _track_task(task)
        else:
          pending.wake_event.set()
  except websockets.ConnectionClosed:
    logger.info("Gateway disconnected")
  finally:
    # Flush dashboard stats and checkpoint DBs before shutting down
    flush_to_db()
    db_checkpoint_all_dbs()
    db_close_all_connections()
    # Detach the queue handler so the webhook server doesn't try to
    # write to a closed ws if a sub-agent queue webhook arrives while
    # we are between gateway connections. Use the identity-checked
    # variant so a slow finally block on an old connection cannot wipe
    # the live handler installed by a newer overlapping connection.
    subagent_webhook.clear_queue_handler_if(_on_subagent_queue_event)
    for task in tasks:
      task.cancel()
    if tasks:
      await asyncio.gather(*tasks, return_exceptions=True)


def _parse_endpoint(url: str):
  parsed = urlsplit(url)
  host = parsed.hostname or "0.0.0.0"
  port = parsed.port or (443 if parsed.scheme == "wss" else 8080)
  return host, port


async def main():
  endpoint = os.getenv("LLM_WS_ENDPOINT", "ws://0.0.0.0:8080/ws")
  host, port = _parse_endpoint(endpoint)
  logger.info("Listening for gateway on %s (host=%s port=%s)", endpoint, host, port)

  # Register cleanup handlers so SQLite connections are closed cleanly on exit,
  # preventing WAL file corruption from unclean shutdowns.
  atexit.register(db_close_all_connections)

  stop_event = asyncio.Event()
  loop = asyncio.get_running_loop()

  def _handle_signal(sig):
    logger.info('Received signal %s, triggering shutdown...', sig)
    stop_event.set()

  for sig in (signal.SIGINT, signal.SIGTERM):
    try:
      loop.add_signal_handler(sig, _handle_signal, sig)
    except NotImplementedError:
      # Windows doesn't support add_signal_handler
      pass

  server = await websockets.serve(
    handle_socket,
    host=host,
    port=port,
    max_size=20 * 1024 * 1024,
    ping_interval=20,
    ping_timeout=20,
  )

  # Start SubAgent webhook server for receiving callback/push from sub-agents.
  # Uses ``start_persistent()`` so the webhook stays alive for the entire
  # bridge lifetime — if the server crashes it is automatically restarted.
  # The webhook should NEVER be stopped during normal operation because
  # WazzapSubAgents relies on it being always reachable for callbacks.
  await subagent_webhook.start_persistent()

  # Wait until stop_event is set (via signal) or server closes on its own
  await stop_event.wait()

  logger.info("Shutting down WebSocket server...")
  server.close()
  await server.wait_closed()

  # Stop the persistent webhook server. This cancels the keeper task
  # and cleanly shuts down the aiohttp site/runner.
  try:
    await subagent_webhook.stop_persistent()
  except Exception as exc:
    logger.error("Error stopping webhook server: %s", exc)

  # Final cleanup
  try:
    # Explicitly call checkpoint and close
    db_checkpoint_all_dbs()
    db_close_all_connections()
    # Unregister atexit since we already closed them
    atexit.unregister(db_close_all_connections)
  except Exception as exc:
    logger.error('Error during final cleanup: %s', exc)


def _shutdown_signal_handler(sig: int) -> None:
  """Legacy signal handler. No longer used by main() loop but kept for reference."""
  logger.info('Received signal %s, shutting down gracefully', sig)
  try:
    db_checkpoint_all_dbs()
    db_close_all_connections()
  except Exception as exc:
    logger.error('Error during shutdown cleanup: %s', exc)


if __name__ == "__main__":
  asyncio.run(main())
