"""``MuteGate`` — inbound mute enforcement (Step 08).

Encapsulates the "before debounce, instant" mute check that lived inline in the
``_dispatch_event`` closure of ``session.py``: if the sender is muted, the
message is deleted immediately. The DB reads and the gateway send functions are
injected, so the gate is unit-testable with fakes — no live socket / LLM.

The one-time "Message from X deleted (muted, …)" first-delete notification was
removed: muting now enforces silently (the visible mute/unmute confirmation is
sent once, by the mute_member dispatch, not on every deleted message).
"""
from __future__ import annotations

from typing import Awaitable, Callable

from ..log import setup_logging

logger = setup_logging()


class MuteGate:
  """Decides whether an inbound payload is from a muted sender and, if so,
  deletes it.

  Injected dependencies mirror the original closure's calls:

  :param is_muted: ``(chat_id, sender_ref) -> bool``
  :param send_delete_message: async ``(ws, chat_id, ctx_id, *, request_id)``
  :param make_request_id: ``(prefix) -> str``
  """

  # Synthetic / non-user message types that are never mute-enforced.
  EXCLUDED_MESSAGE_TYPES = ("groupparticipantsupdate", "actionlog", "botrolechange")

  def __init__(
    self,
    *,
    is_muted: Callable[[str, str], bool],
    send_delete_message: Callable[..., Awaitable[None]],
    make_request_id: Callable[[str], str],
  ) -> None:
    self._is_muted = is_muted
    self._send_delete_message = send_delete_message
    self._make_request_id = make_request_id

  def should_enforce(self, chat_id: str, payload: dict) -> bool:
    """Pure decision: is this payload from a muted sender that must be deleted?"""
    sender_ref = (payload.get("senderRef") or "").strip().lower()
    context_only = bool(payload.get("contextOnly"))
    msg_type = str(payload.get("messageType") or "").strip().lower()
    return bool(
      sender_ref
      and not context_only
      and msg_type not in self.EXCLUDED_MESSAGE_TYPES
      and self._is_muted(chat_id, sender_ref)
    )

  async def enforce(self, ws, chat_id: str, payload: dict) -> bool:
    """Delete the message if the sender is muted (no notification).

    Returns ``True`` when the message was muted and handled (caller must skip
    all further processing), ``False`` otherwise.
    """
    if not self.should_enforce(chat_id, payload):
      return False

    sender_ref = (payload.get("senderRef") or "").strip().lower()
    ctx_id = payload.get("contextMsgId")
    if ctx_id:
      await self._send_delete_message(
        ws,
        chat_id,
        ctx_id,
        request_id=self._make_request_id("mute_enforce"),
      )
    logger.debug(
      "mute enforcement: deleted message from muted user",
      extra={"chat_id": chat_id, "sender_ref": sender_ref},
    )
    return True
