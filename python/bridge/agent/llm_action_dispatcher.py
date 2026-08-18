"""Shared dispatch primitives for actions emitted by any LLM2 entry point."""
from __future__ import annotations

from collections import OrderedDict

from ..messaging.gateway import send_run_command
from ..messaging.processing import _make_request_id


async def dispatch_llm_run_command(
  *,
  ws,
  chat_id: str,
  action: dict,
  pending_run_command_chat: OrderedDict | None = None,
) -> bool:
  """Dispatch one extracted ``run_command`` consistently across all paths.

  The LLM controls the command text and optional message anchor. Node executes
  it as a bot-originated command through the normal command registry.
  """
  command_text = str(action.get("command") or "").strip()
  if not command_text:
    return False
  request_id = _make_request_id("cmd")
  if pending_run_command_chat is not None:
    pending_run_command_chat[request_id] = (chat_id, command_text)
    pending_run_command_chat.move_to_end(request_id)
    while len(pending_run_command_chat) > 4096:
      pending_run_command_chat.popitem(last=False)
  try:
    await send_run_command(
      ws,
      chat_id,
      command_text,
      action.get("contextMsgId"),
      request_id=request_id,
    )
  except Exception:
    # Register before transport delivery so an exceptionally fast ACK cannot
    # beat the correlation map. Roll back only if the send itself fails.
    if pending_run_command_chat is not None:
      pending_run_command_chat.pop(request_id, None)
    raise
  return True


__all__ = ["dispatch_llm_run_command"]
