"""``MuteGate`` — inbound mute enforcement (Step 08).

Encapsulates the "before debounce, instant" mute check that lived inline in the
``_dispatch_event`` closure of ``session.py`` (~2450–2487): if the sender is
muted, the message is deleted immediately and a one-time "deleted (muted)"
notification is sent. The DB reads/writes and the gateway send functions are
injected, so the gate is unit-testable with fakes — no live socket / LLM.
Behaviour is byte-for-byte identical to the original block.
"""
from __future__ import annotations

from typing import Awaitable, Callable, Optional

from ..log import setup_logging

logger = setup_logging()


class MuteGate:
  """Decides whether an inbound payload is from a muted sender and, if so,
  deletes it and emits the first-delete notification.

  Injected dependencies mirror the original closure's calls:

  :param is_muted: ``(chat_id, sender_ref) -> bool``
  :param is_mute_notified: ``(chat_id, sender_ref) -> bool``
  :param mark_mute_notified: ``(chat_id, sender_ref) -> None``
  :param get_mute_remaining: ``(chat_id, sender_ref) -> int`` minutes
  :param send_delete_message: async ``(ws, chat_id, ctx_id, *, request_id)``
  :param send_message: async ``(ws, chat_id, text, reply_to, *, request_id)``
  :param make_request_id: ``(prefix) -> str``
  """

  # Synthetic / non-user message types that are never mute-enforced.
  EXCLUDED_MESSAGE_TYPES = ("groupparticipantsupdate", "actionlog", "botrolechange")

  def __init__(
    self,
    *,
    is_muted: Callable[[str, str], bool],
    is_mute_notified: Callable[[str, str], bool],
    mark_mute_notified: Callable[[str, str], None],
    get_mute_remaining: Callable[[str, str], int],
    send_delete_message: Callable[..., Awaitable[None]],
    send_message: Callable[..., Awaitable[None]],
    make_request_id: Callable[[str], str],
  ) -> None:
    self._is_muted = is_muted
    self._is_mute_notified = is_mute_notified
    self._mark_mute_notified = mark_mute_notified
    self._get_mute_remaining = get_mute_remaining
    self._send_delete_message = send_delete_message
    self._send_message = send_message
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
    """Delete the message + send the first-delete notification if muted.

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
    # First-delete notification
    if not self._is_mute_notified(chat_id, sender_ref):
      self._mark_mute_notified(chat_id, sender_ref)
      remaining = self._get_mute_remaining(chat_id, sender_ref)
      name = payload.get("senderName") or sender_ref
      await self._send_message(
        ws,
        chat_id,
        f"Message from {name} deleted (muted, {remaining}m remaining).",
        None,
        request_id=self._make_request_id("mute_notify"),
      )
    logger.debug(
      "mute enforcement: deleted message from muted user",
      extra={"chat_id": chat_id, "sender_ref": sender_ref},
    )
    return True
