"""Unit tests for :class:`bridge.agent.mute_gate.MuteGate` (Step 08).

Constructs the gate directly with fake db callables and a fake async delete
function that records its calls — no live socket / LLM / DB. Drives the async
``enforce`` with :func:`asyncio.run` (bounded, no hanging tasks).

The first-delete "Message from X deleted (muted, …)" notification was removed,
so the gate now only deletes the muted user's message — it never sends a chat
message.
"""
from __future__ import annotations

import asyncio

from bridge.agent.mute_gate import MuteGate


class _Recorder:
  def __init__(self, muted=False):
    self.muted = muted
    self.deletes = []
    self._req = 0

  # --- db fakes ---
  def is_muted(self, chat_id, sender_ref):
    return self.muted

  # --- gateway fakes (async) ---
  async def send_delete_message(self, ws, chat_id, ctx_id, *, request_id):
    self.deletes.append((chat_id, ctx_id, request_id))

  def make_request_id(self, prefix):
    self._req += 1
    return f"{prefix}-{self._req}"


def _gate(rec: _Recorder) -> MuteGate:
  return MuteGate(
    is_muted=rec.is_muted,
    send_delete_message=rec.send_delete_message,
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


def test_enforce_deletes_without_notification():
  rec = _Recorder(muted=True)
  result = asyncio.run(_gate(rec).enforce(object(), "c@g.us", _payload()))
  assert result is True
  # Message is deleted ...
  assert rec.deletes == [("c@g.us", "000125", "mute_enforce-1")]


def test_enforce_skips_delete_without_context_msg_id():
  rec = _Recorder(muted=True)
  result = asyncio.run(_gate(rec).enforce(object(), "c", _payload(contextMsgId=None)))
  assert result is True
  assert rec.deletes == []
