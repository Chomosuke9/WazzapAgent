"""Unit tests for :class:`bridge.agent.mute_gate.MuteGate` (Step 08).

Constructs the gate directly with fake db callables and fake async gateway send
functions that record their calls — no live socket / LLM / DB. Drives the async
``enforce`` with :func:`asyncio.run` (bounded, no hanging tasks). Mirrors the
former inline mute-enforcement block in ``session.py``.
"""
from __future__ import annotations

import asyncio

from bridge.agent.mute_gate import MuteGate


class _Recorder:
  def __init__(self, muted=False, notified=False, remaining=5):
    self.muted = muted
    self.notified = notified
    self.remaining = remaining
    self.marked = []
    self.deletes = []
    self.messages = []
    self._req = 0

  # --- db fakes ---
  def is_muted(self, chat_id, sender_ref):
    return self.muted

  def is_mute_notified(self, chat_id, sender_ref):
    return self.notified

  def mark_mute_notified(self, chat_id, sender_ref):
    self.marked.append((chat_id, sender_ref))

  def get_mute_remaining(self, chat_id, sender_ref):
    return self.remaining

  # --- gateway fakes (async) ---
  async def send_delete_message(self, ws, chat_id, ctx_id, *, request_id):
    self.deletes.append((chat_id, ctx_id, request_id))

  async def send_message(self, ws, chat_id, text, reply_to, *, request_id):
    self.messages.append((chat_id, text, reply_to, request_id))

  def make_request_id(self, prefix):
    self._req += 1
    return f"{prefix}-{self._req}"


def _gate(rec: _Recorder) -> MuteGate:
  return MuteGate(
    is_muted=rec.is_muted,
    is_mute_notified=rec.is_mute_notified,
    mark_mute_notified=rec.mark_mute_notified,
    get_mute_remaining=rec.get_mute_remaining,
    send_delete_message=rec.send_delete_message,
    send_message=rec.send_message,
    make_request_id=rec.make_request_id,
  )


def _payload(**over):
  base = {
    "senderRef": "u8k2d1",
    "contextOnly": False,
    "messageType": "conversation",
    "contextMsgId": "000125",
    "senderName": "Alice",
  }
  base.update(over)
  return base


# --- pure decision (should_enforce) ---

def test_should_enforce_true_when_muted():
  rec = _Recorder(muted=True)
  assert _gate(rec).should_enforce("c", _payload()) is True


def test_should_enforce_false_when_not_muted():
  rec = _Recorder(muted=False)
  assert _gate(rec).should_enforce("c", _payload()) is False


def test_should_enforce_false_for_empty_sender_ref():
  rec = _Recorder(muted=True)
  assert _gate(rec).should_enforce("c", _payload(senderRef="")) is False


def test_should_enforce_false_for_context_only():
  rec = _Recorder(muted=True)
  assert _gate(rec).should_enforce("c", _payload(contextOnly=True)) is False


def test_should_enforce_false_for_excluded_message_types():
  rec = _Recorder(muted=True)
  for mt in ("groupParticipantsUpdate", "actionLog", "botRoleChange"):
    assert _gate(rec).should_enforce("c", _payload(messageType=mt)) is False


# --- enforce (side effects) ---

def test_enforce_returns_false_and_no_side_effects_when_not_muted():
  rec = _Recorder(muted=False)
  result = asyncio.run(_gate(rec).enforce(object(), "c", _payload()))
  assert result is False
  assert rec.deletes == []
  assert rec.messages == []


def test_enforce_deletes_and_notifies_first_time():
  rec = _Recorder(muted=True, notified=False, remaining=7)
  result = asyncio.run(_gate(rec).enforce(object(), "c@g.us", _payload()))
  assert result is True
  assert rec.deletes == [("c@g.us", "000125", "mute_enforce-1")]
  assert len(rec.messages) == 1
  chat_id, text, reply_to, _req = rec.messages[0]
  assert chat_id == "c@g.us"
  assert text == "Message from Alice deleted (muted, 7m remaining)."
  assert reply_to is None
  assert rec.marked == [("c@g.us", "u8k2d1")]


def test_enforce_deletes_only_when_already_notified():
  rec = _Recorder(muted=True, notified=True)
  result = asyncio.run(_gate(rec).enforce(object(), "c", _payload()))
  assert result is True
  assert len(rec.deletes) == 1
  assert rec.messages == []  # no repeat notification
  assert rec.marked == []


def test_enforce_skips_delete_without_context_msg_id_but_still_notifies():
  rec = _Recorder(muted=True, notified=False)
  result = asyncio.run(_gate(rec).enforce(object(), "c", _payload(contextMsgId=None)))
  assert result is True
  assert rec.deletes == []
  assert len(rec.messages) == 1


def test_enforce_notification_falls_back_to_sender_ref_when_no_name():
  rec = _Recorder(muted=True, notified=False, remaining=3)
  result = asyncio.run(_gate(rec).enforce(object(), "c", _payload(senderName=None)))
  assert result is True
  _chat, text, _reply, _req = rec.messages[0]
  assert text == "Message from u8k2d1 deleted (muted, 3m remaining)."
