"""``AckHydrator`` — provisional->real ``contextMsgId`` hydration on
``action_ack`` (Step 10).

Consolidates the Step-29 ``handle_action_ack`` logic (formerly in
``bridge.messaging.ack_handler``) into the per-account ``agent`` package as the
single home. The module-level :func:`handle_action_ack` is preserved
byte-for-byte (``bridge.messaging.ack_handler`` now re-exports it for
back-compat); :class:`AckHydrator` is a thin per-session wrapper that binds the
account's pending-ack maps + history so ``register()`` can delegate to it.
"""

from __future__ import annotations

from ..log import setup_logging
from ..history import WhatsAppMessage, assistant_name, assistant_sender_ref
from ..messaging.processing import (
  _clean_text,
  _extract_all_send_ack_entries,
  _extract_send_ack_context_msg_id,
  _hydrate_provisional_context_id_from_ack,
  _normalize_context_msg_id,
)

import time

logger = setup_logging()


def _append_sticker_log_to_history(history, log_text: str) -> None:
  """Append a synthetic assistant entry to the conversation history.

  Mirrors ``bridge.main._append_sticker_log_to_history`` exactly so the
  ``run_command`` outcome line keeps the same shape the inline command handler
  emits.
  """
  history.append(WhatsAppMessage(
    timestamp_ms=int(time.time() * 1000),
    sender=assistant_name(),
    sender_ref=assistant_sender_ref(),
    text=log_text,
    role="assistant",
  ))


async def handle_action_ack(
  ack,
  *,
  per_chat,
  per_chat_lock,
  pending_send_request_chat,
  pending_subagent_attachments,
  pending_run_command_chat,
  media_paths_by_chat,
):
  """Process one ``action_ack`` (Step 29). Behavior preserved verbatim from the
  removed ``async for raw in ws`` ack branch."""
  event_type = "action_ack"
  payload = {
    "requestId": getattr(ack, "request_id", None),
    "action": getattr(ack, "action", None),
    "ok": getattr(ack, "ok", None),
    "detail": getattr(ack, "detail", None),
    "result": getattr(ack, "result", None),
    "code": getattr(ack, "code", None),
  }
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
  logger.debug("Gateway ack: %s", payload)


class AckHydrator:
  """Per-account ``action_ack`` hydrator. Holds the session's pending-ack maps
  and history containers (by reference) and delegates to the verbatim
  :func:`handle_action_ack` so behaviour is identical to the Step-29 handler."""

  def __init__(
    self,
    *,
    per_chat,
    per_chat_lock,
    pending_send_request_chat,
    pending_subagent_attachments,
    pending_run_command_chat,
    media_paths_by_chat,
  ) -> None:
    self._per_chat = per_chat
    self._per_chat_lock = per_chat_lock
    self._pending_send_request_chat = pending_send_request_chat
    self._pending_subagent_attachments = pending_subagent_attachments
    self._pending_run_command_chat = pending_run_command_chat
    self._media_paths_by_chat = media_paths_by_chat

  async def handle(self, ack) -> None:
    await handle_action_ack(
      ack,
      per_chat=self._per_chat,
      per_chat_lock=self._per_chat_lock,
      pending_send_request_chat=self._pending_send_request_chat,
      pending_subagent_attachments=self._pending_subagent_attachments,
      pending_run_command_chat=self._pending_run_command_chat,
      media_paths_by_chat=self._media_paths_by_chat,
    )
