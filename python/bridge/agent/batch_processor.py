"""``BatchProcessor`` — debounce/burst assembly + per-batch pipeline (Step 10).

Owns the orchestration that used to live in the ``process_message_batch`` /
``flush_pending`` / incoming-message portion of ``_dispatch_event`` closures in
``session.py``:

  * :meth:`dispatch_incoming` — mute gate, activation gate, bot-role-change,
    and debounce enqueue (session.py ~2261–2329).
  * :meth:`flush_pending` — the per-chat debounce/burst worker (session.py
    ~2094–2159).
  * :meth:`process_message_batch` — slash-command handling, LLM1 routing
    (with hybrid prefix-interrupt), LLM2 generation + action dispatch
    (session.py ~494–2092). The ``execute_subtask`` action is delegated to the
    per-session :class:`~bridge.agent.subagent_coordinator.SubAgentCoordinator`.

Constructed with the owning :class:`AgentSession` so every per-account
container + collaborator (``per_chat``, ``pending_by_chat``, the dashboard,
``MuteGate`` / ``IdleTrigger`` / ``ReplyDedup`` / ``Llm1Router`` /
``Llm2Responder`` / ``SubAgentCoordinator``) stays INSTANCE-scoped. The method
bodies bind those to locals of the same name the closures used, so the moved
logic — including all async timing (debounce windows, prefix-interrupt
cancellation, per-chat locks) — is byte-for-byte identical.
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


@dataclass
class PendingChat:
  payloads: list[dict] = field(default_factory=list)
  burst_started_at: float | None = None
  last_event_at: float | None = None
  wake_event: asyncio.Event = field(default_factory=asyncio.Event)
  prefix_interrupt: asyncio.Event = field(default_factory=asyncio.Event)
  task: asyncio.Task | None = None
  lock: asyncio.Lock = field(default_factory=asyncio.Lock)


@dataclass
class _BatchCtx:
  """Per-invocation batch state threaded across the phase methods.

  This is a LOCAL object created once per ``process_message_batch`` call, never
  shared instance state — so concurrent batches (different chats) never collide.
  The phase methods bind the fields they need to locals of the original names so
  the moved logic stays byte-for-byte identical, and write their outputs back
  here for the next phase.
  """
  payloads: list
  non_empty_payloads: list
  llm1_trigger_payloads: list
  context_only_payloads: list
  passive_context_payloads: list
  last_trigger_index: int | None
  last_payload: dict
  chat_id: str
  history: object
  lock: object
  batch_started: float
  last_payload_ts: int | None
  lock_wait_ms: int = 0
  llm1_ms: int = 0
  llm2_ms: int = 0
  action_send_ms: int = 0
  trigger_window_payloads: list = field(default_factory=list)
  history_before_current: list = field(default_factory=list)
  current: object = None
  llm1_history: list = field(default_factory=list)
  llm1_current: object = None
  llm2_history: list = field(default_factory=list)
  group_description: object = None
  db_prompt: object = None
  chat_type: str = ""
  bot_is_admin: bool = False
  bot_is_super_admin: bool = False
  llm_context_metadata: dict = field(default_factory=dict)
  llm1_payload: dict = field(default_factory=dict)
  decision: object = None
  allowed_context_ids: object = None
  fallback_reply_to: object = None
  llm2_payload: dict = field(default_factory=dict)


class BatchProcessor:
  """Per-account batch orchestrator (Step 10). See module docstring."""

  def __init__(self, session) -> None:
    self._session = session


  async def process_message_batch(self, payloads: list[dict]):
    session = self._session
    media_paths_by_chat = session.media_paths_by_chat
    per_chat = session.per_chat
    per_chat_lock = session.per_chat_lock
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

    non_empty_payloads = await self._process_slash_commands(non_empty_payloads)
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

    ctx = _BatchCtx(
      payloads=payloads,
      non_empty_payloads=non_empty_payloads,
      llm1_trigger_payloads=llm1_trigger_payloads,
      context_only_payloads=context_only_payloads,
      passive_context_payloads=passive_context_payloads,
      last_trigger_index=last_trigger_index,
      last_payload=last_payload,
      chat_id=chat_id,
      history=history,
      lock=lock,
      batch_started=batch_started,
      last_payload_ts=last_payload_ts,
    )

    lock_wait_started = time.perf_counter()
    async with lock:
      ctx.lock_wait_ms = int((time.perf_counter() - lock_wait_started) * 1000)
      try:
        if not await self._assemble_burst(ctx):
          return
        if not await self._run_llm1(ctx):
          return
        if not await self._apply_llm1_decision(ctx):
          return
        actions = await self._run_llm2(ctx)
        if actions is None:
          return
        action_counts = await self._dispatch_actions(ctx, actions)
        logger.info(
          "executed actions",
          extra={
            "chat_id": chat_id,
            "action_counts": action_counts,
            "batch_size": len(llm1_trigger_payloads),
            "action_total": len(actions),
          },
        )
        self._log_slow_batch(
          ctx,
          "actions_executed",
          llm1_ms=ctx.llm1_ms,
          llm2_ms=ctx.llm2_ms,
          action_send_ms=ctx.action_send_ms,
          action_counts=action_counts,
          action_total=len(actions),
        )
      except Exception as err:
        self._log_slow_batch(
          ctx,
          "handler_error",
          llm1_ms=ctx.llm1_ms,
          llm2_ms=ctx.llm2_ms,
          action_send_ms=ctx.action_send_ms,
        )
        logger.exception("handler error: %s", err, extra={"chat_id": chat_id})

  async def _process_slash_commands(self, non_empty_payloads: list[dict]) -> list[dict]:
    session = self._session
    ws = session.sock
    per_chat = session.per_chat
    idle_msg_count = session.idle_msg_count
    subagent_tracker = session.subagent_tracker
    media_paths_by_chat = session.media_paths_by_chat
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
          from .llm.prompt import _render_system_prompt, _load_system_prompt, _group_description_block, _chat_state_header, _current_date_str
          from .db import get_permission as _get_perm, permission_allows_delete, permission_allows_mute, permission_allows_kick, get_subagent_enabled as _get_subagent
        except ImportError:
          from bridge.llm.prompt import _render_system_prompt, _load_system_prompt, _group_description_block, _chat_state_header, _current_date_str  # type: ignore
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
        # Lazy import (Step 32): keep PIL out of this module's import graph so
        # ``session`` (and test_agent_session) import without Pillow installed.
        try:
          from .tools.sticker import create_sticker_file
        except ImportError:
          from bridge.tools.sticker import create_sticker_file  # type: ignore
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
            session._dashboard.record_stat(p_chat_id, "stickers_sent")
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

    return remaining_payloads

  def _log_slow_batch(self, ctx, outcome, *, llm1_ms=0, llm2_ms=0, action_send_ms=0, action_counts=None, action_total=0):
    total_ms = int((time.perf_counter() - ctx.batch_started) * 1000)
    if total_ms < SLOW_BATCH_LOG_MS and ctx.lock_wait_ms < SLOW_BATCH_LOG_MS:
      return
    payload_age_ms = None
    if ctx.last_payload_ts is not None:
      payload_age_ms = max(0, int(time.time() * 1000) - ctx.last_payload_ts)
    logger.info(
      "slow batch observed",
      extra={
        "chat_id": ctx.chat_id,
        "outcome": outcome,
        "batch_size": len(ctx.payloads),
        "non_empty_batch_size": len(ctx.non_empty_payloads),
        "llm1_trigger_batch_size": len(ctx.llm1_trigger_payloads),
        "context_only_batch_size": len(ctx.context_only_payloads),
        "passive_context_batch_size": len(ctx.passive_context_payloads),
        "lock_wait_ms": ctx.lock_wait_ms,
        "llm1_ms": llm1_ms,
        "llm2_ms": llm2_ms,
        "action_send_ms": action_send_ms,
        "total_ms": total_ms,
        "payload_age_ms": payload_age_ms,
        "history_len": len(ctx.history),
        "last_message_id": ctx.last_payload.get("messageId"),
        "last_type": ctx.last_payload.get("messageType"),
        "last_sender": ctx.last_payload.get("senderName") or ctx.last_payload.get("senderId"),
        "action_counts": action_counts,
        "action_total": action_total,
      },
    )

  async def _assemble_burst(self, ctx) -> bool:
    chat_id = ctx.chat_id
    history = ctx.history
    payloads = ctx.payloads
    non_empty_payloads = ctx.non_empty_payloads
    llm1_trigger_payloads = ctx.llm1_trigger_payloads
    context_only_payloads = ctx.context_only_payloads
    passive_context_payloads = ctx.passive_context_payloads
    last_trigger_index = ctx.last_trigger_index
    last_payload = ctx.last_payload
    last_payload_ts = ctx.last_payload_ts
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
      self._log_slow_batch(ctx, "context_only")
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
      self._log_slow_batch(ctx, "stale_skip")
      return
    ctx.trigger_window_payloads = trigger_window_payloads
    ctx.history_before_current = history_before_current
    ctx.current = current
    ctx.llm1_history = llm1_history
    ctx.llm1_current = llm1_current
    ctx.llm2_history = llm2_history
    return True

  async def _run_llm1(self, ctx) -> bool:
    session = self._session
    chat_id = ctx.chat_id
    history = ctx.history
    non_empty_payloads = ctx.non_empty_payloads
    llm1_trigger_payloads = ctx.llm1_trigger_payloads
    trigger_window_payloads = ctx.trigger_window_payloads
    history_before_current = ctx.history_before_current
    current = ctx.current
    llm1_history = ctx.llm1_history
    llm1_current = ctx.llm1_current
    last_payload = ctx.last_payload
    pending_by_chat = session.pending_by_chat
    idle_msg_count = session.idle_msg_count
    _should_idle_trigger = session._idle.should_trigger
    llm1_ms = 0
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
      session._dashboard.record_stat(chat_id, "messages_processed")
      if bool(_dp.get("botMentioned")):
        session._dashboard.record_stat(chat_id, "bot_tags")
      _dp_text = _clean_text(_dp.get("text"))
      if _dp_text and assistant_name_pattern().search(_dp_text):
        session._dashboard.record_stat(chat_id, "bot_name_mentions")

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
          self._log_slow_batch(ctx, "prefix_no_match")
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
            session._dashboard.record_user_invoke(chat_id, _pp_ref, _pp_name)
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
            session._dashboard.record_user_invoke(chat_id, _pp_ref, _pp_name)
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

        llm1_task = asyncio.create_task(session._llm1.route(
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
                session._dashboard.record_user_invoke(chat_id, _np_ref, _np_name)
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
          session._dashboard.record_stat(chat_id, "llm1_calls")
          if decision.input_tokens:
            session._dashboard.record_stat(chat_id, "llm1_input_tokens", decision.input_tokens)
          if decision.output_tokens:
            session._dashboard.record_stat(chat_id, "llm1_output_tokens", decision.output_tokens)
          if decision.should_response:
            for _ap in llm1_trigger_payloads:
              _ap_ref = _clean_text(_ap.get("senderRef"))
              _ap_name = _clean_text(_ap.get("senderName"))
              if _ap_ref:
                session._dashboard.record_user_invoke(chat_id, _ap_ref, _ap_name)
          logger.info(
            "hybrid mode: LLM1 completed in %dms (no prefix interrupt); should_response=%s",
            llm1_ms, decision.should_response,
            extra={"chat_id": chat_id, "confidence": decision.confidence},
          )
    else:
      llm1_started = time.perf_counter()
      decision = await session._llm1.route(
        llm1_history,
        llm1_current,
        current_payload=llm1_payload,
        group_description=group_description,
        prompt_override=db_prompt,
      )
      llm1_ms = int((time.perf_counter() - llm1_started) * 1000)
      session._dashboard.record_stat(chat_id, "llm1_calls")
      if decision.input_tokens:
        session._dashboard.record_stat(chat_id, "llm1_input_tokens", decision.input_tokens)
      if decision.output_tokens:
        session._dashboard.record_stat(chat_id, "llm1_output_tokens", decision.output_tokens)
      # Record invoking user for auto mode too
      if decision.should_response:
        for _ap in llm1_trigger_payloads:
          _ap_ref = _clean_text(_ap.get("senderRef"))
          _ap_name = _clean_text(_ap.get("senderName"))
          if _ap_ref:
            session._dashboard.record_user_invoke(chat_id, _ap_ref, _ap_name)
    ctx.decision = decision
    ctx.group_description = group_description
    ctx.db_prompt = db_prompt
    ctx.chat_type = chat_type
    ctx.bot_is_admin = bot_is_admin
    ctx.bot_is_super_admin = bot_is_super_admin
    ctx.llm_context_metadata = llm_context_metadata
    ctx.llm1_payload = llm1_payload
    ctx.current = current
    ctx.trigger_window_payloads = trigger_window_payloads
    ctx.llm1_ms = llm1_ms
    return True

  async def _apply_llm1_decision(self, ctx) -> bool:
    session = self._session
    ws = session.sock
    chat_id = ctx.chat_id
    history = ctx.history
    non_empty_payloads = ctx.non_empty_payloads
    llm1_trigger_payloads = ctx.llm1_trigger_payloads
    trigger_window_payloads = ctx.trigger_window_payloads
    decision = ctx.decision
    idle_msg_count = session.idle_msg_count
    _should_idle_trigger = session._idle.should_trigger
    llm1_ms = ctx.llm1_ms
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
        session._dashboard.record_stat(chat_id, "stickers_sent")
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
      self._log_slow_batch(ctx, "llm1_express", llm1_ms=llm1_ms)
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
        self._log_slow_batch(ctx, "llm1_skip", llm1_ms=llm1_ms)
        return
    ctx.decision = decision
    return True

  async def _run_llm2(self, ctx):
    session = self._session
    ws = session.sock
    chat_id = ctx.chat_id
    history = ctx.history
    last_payload = ctx.last_payload
    trigger_window_payloads = ctx.trigger_window_payloads
    llm_context_metadata = ctx.llm_context_metadata
    decision = ctx.decision
    group_description = ctx.group_description
    db_prompt = ctx.db_prompt
    chat_type = ctx.chat_type
    bot_is_admin = ctx.bot_is_admin
    bot_is_super_admin = ctx.bot_is_super_admin
    current = ctx.current
    llm2_history = ctx.llm2_history
    media_paths_by_chat = session.media_paths_by_chat
    idle_msg_count = session.idle_msg_count
    llm1_trigger_payloads = ctx.llm1_trigger_payloads
    _should_idle_trigger = session._idle.should_trigger
    subagent_tracker = session.subagent_tracker
    llm1_ms = ctx.llm1_ms
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
      _validate_llm2_result = session._llm2.make_validator(
        fallback_reply_to=fallback_reply_to,
        allowed_context_ids=allowed_context_ids,
      )

      reply_msg = await session._llm2.generate(
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
    ctx.llm2_ms = llm2_ms
    session._dashboard.record_stat(chat_id, "llm2_calls")
    # Track LLM2 token usage if available
    if reply_msg is not None:
      _usage = getattr(reply_msg, "usage_metadata", None)
      if isinstance(_usage, dict):
        _in_tok = _usage.get("input_tokens", 0)
        _out_tok = _usage.get("output_tokens", 0)
        if _in_tok:
          session._dashboard.record_stat(chat_id, "llm2_input_tokens", _in_tok)
        if _out_tok:
          session._dashboard.record_stat(chat_id, "llm2_output_tokens", _out_tok)
    if reply_msg is None:
      session._dashboard.record_stat(chat_id, "errors")
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
      self._log_slow_batch(ctx, "llm2_none", llm1_ms=llm1_ms, llm2_ms=llm2_ms)
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
      self._log_slow_batch(ctx, "no_action", llm1_ms=llm1_ms, llm2_ms=llm2_ms)
      return
    ctx.allowed_context_ids = allowed_context_ids
    ctx.fallback_reply_to = fallback_reply_to
    ctx.llm2_payload = llm2_payload
    ctx.llm2_ms = llm2_ms
    return actions

  async def _dispatch_actions(self, ctx, actions) -> dict:
    session = self._session
    ws = session.sock
    chat_id = ctx.chat_id
    history = ctx.history
    lock = ctx.lock
    current = ctx.current
    llm2_payload = ctx.llm2_payload
    group_description = ctx.group_description
    db_prompt = ctx.db_prompt
    chat_type = ctx.chat_type
    bot_is_admin = ctx.bot_is_admin
    bot_is_super_admin = ctx.bot_is_super_admin
    fallback_reply_to = ctx.fallback_reply_to
    allowed_context_ids = ctx.allowed_context_ids
    _is_duplicate_reply = session._dedup.is_duplicate
    pending_send_request_chat = session.pending_send_request_chat
    pending_run_command_chat = session.pending_run_command_chat
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
        session._dashboard.record_stat(chat_id, "responses_sent")
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
          session._dashboard.record_stat(chat_id, "stickers_sent")
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
          session._dashboard.record_stat(chat_id, "stickers_sent")
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
        session._dashboard.record_stat(chat_id, "responses_sent")
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
        await session._subagent.submit_subtask(
          action=action,
          chat_id=chat_id,
          history=history,
          lock=lock,
          current=current,
          llm2_payload=llm2_payload,
          group_description=group_description,
          db_prompt=db_prompt,
          chat_type=chat_type,
          bot_is_admin=bot_is_admin,
          bot_is_super_admin=bot_is_super_admin,
          fallback_reply_to=fallback_reply_to,
          allowed_context_ids=allowed_context_ids,
        )
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
    ctx.action_send_ms = action_send_ms
    return action_counts

  async def flush_pending(self, chat_id: str):
    session = self._session
    pending_by_chat = session.pending_by_chat
    process_message_batch = self.process_message_batch
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

  async def dispatch_incoming(self, payload):
    session = self._session
    ws = session.sock
    pending_by_chat = session.pending_by_chat
    flush_pending = self.flush_pending
    _track_task = session._track_task
    chat_id = payload.get("chatId")
    if not chat_id:
      logger.warning("Dropping incoming_message without chatId")
      return

    # --- Mute enforcement (before debounce, instant) ---
    # Step 08: delegated to the per-session MuteGate collaborator. ``enforce``
    # returns True (and has already deleted + notified) when the sender is
    # muted, in which case we skip all further processing. ``_mute_msg_type``
    # stays here because the bot-role-change branch below still needs it.
    _mute_msg_type = str(payload.get("messageType") or "").strip().lower()
    if await session._mute.enforce(ws, chat_id, payload):
      return  # skip all further processing

    # --- Activation gate (safety net, primary gate is in Node.js) ---
    if REQUIRE_ACTIVATION:
      _act_sender_is_owner = bool(payload.get("senderIsOwner"))
      _act_chat_type = str(payload.get("chatType") or "").strip().lower()
      if not _act_sender_is_owner and not db_is_chat_activated(chat_id):
        logger.debug(
          "activation gate: dropping message from unactivated chat",
          extra={"chat_id": chat_id},
        )
        return

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
      return

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
