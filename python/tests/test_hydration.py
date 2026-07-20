"""Step 29 — provisional-history hydration reconcile tests.

Drives the agent's re-homed ``action_ack`` handler
(:func:`bridge.agent.ack_hydrator.handle_action_ack`) directly with a
synthetic :class:`wasocket.protocol.AckResult` and asserts the three behaviors
the old ``async for raw in ws`` loop used to provide are preserved verbatim:

  (a) a provisional send entry (``context_msg_id="pending"``,
      ``message_id="local-send-<rid>"``) becomes the real 6-digit id after an
      ``action_ack`` for that ``requestId``;
  (b) a sub-agent attachment ``action_ack`` stores the file path in
      ``media_paths_by_chat`` under the real ``contextMsgId``;
  (c) a ``run_command`` ``action_ack`` appends
      ``"Command <name> executed successfully"`` (``ok=True``) / the failure
      line (``ok=False``) to that chat's history.

These import only the dependency-light ``ack_hydrator`` module (NOT
``bridge.main``, which pulls in PIL / langchain), mirroring how
``test_idle_trigger`` avoids the heavy import.
"""
import asyncio
from collections import OrderedDict, defaultdict, deque

from bridge.history import WhatsAppMessage
from bridge.agent.ack_hydrator import handle_action_ack
from wasocket.protocol import AckResult


def _fresh_state():
  return {
    "per_chat": defaultdict(deque),
    "per_chat_lock": defaultdict(asyncio.Lock),
    "pending_send_request_chat": OrderedDict(),
    "pending_subagent_attachments": OrderedDict(),
    "pending_run_command_chat": OrderedDict(),
    "media_paths_by_chat": defaultdict(dict),
  }


def _provisional_entry(request_id: str, text: str = "hello world") -> WhatsAppMessage:
  return WhatsAppMessage(
    timestamp_ms=1_700_000_000_000,
    sender="LLM",
    sender_ref="You",
    text=text,
    role="assistant",
    context_msg_id="pending",
    message_id=f"local-send-{request_id}",
  )


# ---------------------------------------------------------------------------
# (a) provisional send entry -> real contextMsgId
# ---------------------------------------------------------------------------

def test_send_ack_hydrates_provisional_context_id():
  state = _fresh_state()
  chat_id = "123@g.us"
  rid = "send-1715097600000-000001"

  history = state["per_chat"][chat_id]
  history.append(_provisional_entry(rid))
  state["pending_send_request_chat"][rid] = chat_id

  ack = AckResult(
    request_id=rid,
    action="send_message",
    ok=True,
    detail="sent",
    result={"sent": [{"kind": "text", "contextMsgId": "000123"}]},
  )

  asyncio.run(handle_action_ack(ack, **state))

  assert history[0].context_msg_id == "000123"
  # The pending entry must have been consumed.
  assert rid not in state["pending_send_request_chat"]


def test_send_ack_without_matching_pending_is_noop():
  state = _fresh_state()
  chat_id = "123@g.us"
  rid = "send-x"
  # Provisional entry exists but the request was never tracked -> no hydration.
  history = state["per_chat"][chat_id]
  history.append(_provisional_entry(rid))

  ack = AckResult(
    request_id=rid,
    action="send_message",
    ok=True,
    detail="sent",
    result={"sent": [{"kind": "text", "contextMsgId": "000999"}]},
  )
  asyncio.run(handle_action_ack(ack, **state))

  # Not tracked in pending_send_request_chat -> stays provisional.
  assert history[0].context_msg_id == "pending"


# ---------------------------------------------------------------------------
# (b) sub-agent attachment ack -> media_paths_by_chat
# ---------------------------------------------------------------------------

def test_subagent_attachment_ack_stores_media_path():
  state = _fresh_state()
  chat_id = "456@g.us"
  rid = "subagent_attach-1715097600000-000042"
  file_info = {"path": "/data/media/subagent_out/sess/report.pdf", "name": "report.pdf"}
  state["pending_subagent_attachments"][rid] = (chat_id, [file_info])

  ack = AckResult(
    request_id=rid,
    action="send_message",
    ok=True,
    detail="sent",
    result={"sent": [{"kind": "document", "contextMsgId": "000200"}]},
  )

  asyncio.run(handle_action_ack(ack, **state))

  stored = state["media_paths_by_chat"][chat_id]["000200"]
  assert isinstance(stored, list) and len(stored) == 1
  assert stored[0]["path"] == "/data/media/subagent_out/sess/report.pdf"
  assert stored[0]["name"] == "report.pdf"
  assert "received_at" in stored[0]
  assert rid not in state["pending_subagent_attachments"]


def test_failed_subagent_attachment_ack_is_retained_and_reported():
  state = _fresh_state()
  chat_id = "456@g.us"
  rid = "subagent_attach-failed"
  file_info = {"path": "/data/media/report.pdf", "name": "report.pdf"}
  state["pending_subagent_attachments"][rid] = (chat_id, [file_info])

  ack = AckResult(
    request_id=rid,
    action="send_message",
    ok=False,
    detail="attachment path is outside tenant media dir",
    code="invalid_target",
    result={},
  )
  asyncio.run(handle_action_ack(ack, **state))

  assert rid in state["pending_subagent_attachments"]
  retained = state["pending_subagent_attachments"][rid][1][0]
  assert retained["ack_code"] == "invalid_target"
  assert "outside tenant media" in retained["ack_error"]
  assert state["media_paths_by_chat"][chat_id] == {}
  assert "Failed to send sub-agent attachment" in state["per_chat"][chat_id][-1].text


def test_success_ack_without_context_id_retains_pending_attachment():
  state = _fresh_state()
  chat_id = "456@g.us"
  rid = "subagent_attach-missing-context"
  state["pending_subagent_attachments"][rid] = (
    chat_id, [{"path": "/data/media/report.pdf", "name": "report.pdf"}],
  )

  ack = AckResult(
    request_id=rid,
    action="send_message",
    ok=True,
    detail="sent",
    result={"sent": [{"kind": "document", "contextMsgId": None}]},
  )
  asyncio.run(handle_action_ack(ack, **state))

  assert rid in state["pending_subagent_attachments"]
  assert state["media_paths_by_chat"][chat_id] == {}


# ---------------------------------------------------------------------------
# (c) run_command ack -> synthetic history line
# ---------------------------------------------------------------------------

def test_run_command_ack_ok_appends_success_line():
  state = _fresh_state()
  chat_id = "789@g.us"
  rid = "cmd-1715097600000-000007"
  state["pending_run_command_chat"][rid] = (chat_id, "/sticker upper#lower")

  ack = AckResult(
    request_id=rid,
    action="run_command",
    ok=True,
    detail="executed",
    result={"command": "sticker"},
  )

  asyncio.run(handle_action_ack(ack, **state))

  history = state["per_chat"][chat_id]
  assert len(history) == 1
  assert history[-1].text == "Command sticker executed successfully"
  assert history[-1].role == "assistant"
  assert rid not in state["pending_run_command_chat"]


def test_run_command_ack_failure_appends_failure_line():
  state = _fresh_state()
  chat_id = "789@g.us"
  rid = "cmd-fail-1"
  state["pending_run_command_chat"][rid] = (chat_id, "/join https://bad")

  ack = AckResult(
    request_id=rid,
    action="run_command",
    ok=False,
    detail="invalid invite link",
    code="invalid_target",
    result={"command": "join"},
  )

  asyncio.run(handle_action_ack(ack, **state))

  history = state["per_chat"][chat_id]
  assert len(history) == 1
  assert history[-1].text == "Command join failed: invalid invite link"


def test_run_command_ack_infers_command_name_when_result_missing():
  state = _fresh_state()
  chat_id = "789@g.us"
  rid = "cmd-2"
  state["pending_run_command_chat"][rid] = (chat_id, "/help")

  ack = AckResult(
    request_id=rid,
    action="run_command",
    ok=True,
    detail="executed",
    result={},
  )

  asyncio.run(handle_action_ack(ack, **state))

  history = state["per_chat"][chat_id]
  assert history[-1].text == "Command help executed successfully"
