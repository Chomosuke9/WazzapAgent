"""Tests for queue-event webhook handling in
``bridge/subagent/webhook_server.py``.

These pin the contract that:

- ``queued`` and ``queue_advanced`` callbacks from WazzapSubAgents are
  routed to the registered handler with the right (chat_id, type,
  position, queue_size) arguments;
- duplicate webhooks (same session_id + position + queue_size) are
  suppressed within the dedup window;
- unknown / already-finished sessions are dropped without crashing;
- the eventual WhatsApp text matches the literal format the user spec
  demands.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import List, Tuple
from unittest.mock import AsyncMock

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from bridge.subagent.tracker import SubTaskTracker  # noqa: E402
from bridge.subagent.models import SubTask  # noqa: E402
from bridge.subagent.webhook_server import SubAgentWebhookServer  # noqa: E402


class _FakeRequest:
  """Minimal aiohttp.Request stand-in. ``_handle_callback`` only calls
  ``await request.json()`` so this is all we need.
  """

  def __init__(self, payload: dict) -> None:
    self._payload = payload

  async def json(self) -> dict:
    return self._payload


def _make_tracker_with_session(session_id: str, chat_id: str) -> SubTaskTracker:
  tracker = SubTaskTracker()
  tracker.register(SubTask(
    session_id=session_id,
    chat_id=chat_id,
    instruction="dummy",
  ))
  return tracker


@pytest.mark.asyncio
async def test_queued_webhook_dispatches_to_handler():
  tracker = _make_tracker_with_session("sess-B", "chat-bob@s.whatsapp.net")
  server = SubAgentWebhookServer(tracker, port=0)
  handler = AsyncMock()
  server.set_queue_handler(handler)

  resp = await server._handle_callback(_FakeRequest({
    "type": "queued",
    "session_id": "sess-B",
    "position": 1,
    "queue_size": 1,
  }))

  assert resp.status == 200
  handler.assert_awaited_once_with("chat-bob@s.whatsapp.net", "queued", 1, 1)


@pytest.mark.asyncio
async def test_queue_advanced_webhook_dispatches_to_handler():
  tracker = _make_tracker_with_session("sess-C", "chat-carol@s.whatsapp.net")
  server = SubAgentWebhookServer(tracker, port=0)
  handler = AsyncMock()
  server.set_queue_handler(handler)

  resp = await server._handle_callback(_FakeRequest({
    "type": "queue_advanced",
    "session_id": "sess-C",
    "position": 1,
    "queue_size": 1,
  }))

  assert resp.status == 200
  handler.assert_awaited_once_with(
    "chat-carol@s.whatsapp.net", "queue_advanced", 1, 1
  )


@pytest.mark.asyncio
async def test_dedup_suppresses_repeated_queue_event_within_window():
  tracker = _make_tracker_with_session("sess-D", "chat-dave@s.whatsapp.net")
  server = SubAgentWebhookServer(tracker, port=0)
  handler = AsyncMock()
  server.set_queue_handler(handler)

  payload = {
    "type": "queued",
    "session_id": "sess-D",
    "position": 1,
    "queue_size": 1,
  }
  await server._handle_callback(_FakeRequest(dict(payload)))
  await server._handle_callback(_FakeRequest(dict(payload)))

  assert handler.await_count == 1, (
    "Duplicate (session, position, queue_size) within the dedup window "
    "must NOT fan out a second WhatsApp notification."
  )

  # A different position is a real new event and must dispatch.
  await server._handle_callback(_FakeRequest({
    "type": "queue_advanced",
    "session_id": "sess-D",
    "position": 2,
    "queue_size": 2,
  }))
  assert handler.await_count == 2


@pytest.mark.asyncio
async def test_queue_event_for_unknown_session_is_dropped_silently():
  tracker = SubTaskTracker()  # no sessions registered
  server = SubAgentWebhookServer(tracker, port=0)
  handler = AsyncMock()
  server.set_queue_handler(handler)

  resp = await server._handle_callback(_FakeRequest({
    "type": "queued",
    "session_id": "ghost",
    "position": 1,
    "queue_size": 1,
  }))

  assert resp.status == 200
  handler.assert_not_awaited()


@pytest.mark.asyncio
async def test_queue_event_with_no_handler_registered_is_noop():
  tracker = _make_tracker_with_session("sess-E", "chat-erin@s.whatsapp.net")
  server = SubAgentWebhookServer(tracker, port=0)
  # Do NOT register a handler — simulates the "gateway disconnected"
  # window between WS connections.

  resp = await server._handle_callback(_FakeRequest({
    "type": "queued",
    "session_id": "sess-E",
    "position": 1,
    "queue_size": 1,
  }))

  # The webhook must succeed (200) so the sub-agent doesn't keep
  # retrying — but no message is sent.
  assert resp.status == 200


@pytest.mark.asyncio
async def test_bad_position_returns_400():
  tracker = _make_tracker_with_session("sess-F", "chat-frank")
  server = SubAgentWebhookServer(tracker, port=0)
  server.set_queue_handler(AsyncMock())

  resp = await server._handle_callback(_FakeRequest({
    "type": "queued",
    "session_id": "sess-F",
    "position": "not-an-int",
    "queue_size": 1,
  }))

  assert resp.status == 400


@pytest.mark.asyncio
async def test_handler_renders_expected_whatsapp_text():
  """End-to-end-ish: simulate the wiring done in main.py's
  ``handle_socket`` so we cover the literal text the user will see.
  This is the source-of-truth for the spec strings.
  """

  tracker = _make_tracker_with_session("sess-X", "chat-x@s.whatsapp.net")
  server = SubAgentWebhookServer(tracker, port=0)

  sent: List[Tuple[str, str]] = []

  async def fake_send(chat_id: str, text: str) -> None:
    sent.append((chat_id, text))

  async def main_py_style_handler(
    chat_id: str, event_type: str, position: int, queue_size: int
  ) -> None:
    # Mirrors the handler in WazzapAgents/python/bridge/main.py.
    if event_type == "queued":
      text = f"container is used by other session.\ncurrent queue: {position}"
    else:
      text = f"current queue: {position}"
    await fake_send(chat_id, text)

  server.set_queue_handler(main_py_style_handler)

  await server._handle_callback(_FakeRequest({
    "type": "queued",
    "session_id": "sess-X",
    "position": 1,
    "queue_size": 1,
  }))
  await server._handle_callback(_FakeRequest({
    "type": "queue_advanced",
    "session_id": "sess-X",
    "position": 2,
    "queue_size": 2,
  }))

  assert sent == [
    ("chat-x@s.whatsapp.net",
     "container is used by other session.\ncurrent queue: 1"),
    ("chat-x@s.whatsapp.net", "current queue: 2"),
  ]


@pytest.mark.asyncio
async def test_handler_failure_does_not_suppress_retry_within_window():
  """Regression: when the handler raises, we must NOT record dedup
  state, otherwise a sub-agent retry of the same (position, queue_size)
  within the 5 s window would be silently dropped.
  """

  tracker = _make_tracker_with_session("sess-Y", "chat-y@s.whatsapp.net")
  server = SubAgentWebhookServer(tracker, port=0)

  call_count = {"n": 0}

  async def flaky_handler(chat_id: str, event_type: str, position: int, queue_size: int) -> None:
    call_count["n"] += 1
    if call_count["n"] == 1:
      raise RuntimeError("simulated transient WS failure")

  server.set_queue_handler(flaky_handler)

  payload = {
    "type": "queued",
    "session_id": "sess-Y",
    "position": 1,
    "queue_size": 1,
  }

  resp1 = await server._handle_callback(_FakeRequest(dict(payload)))
  assert resp1.status == 500, "first attempt failed → must surface 500 to trigger retry"

  resp2 = await server._handle_callback(_FakeRequest(dict(payload)))
  assert resp2.status == 200, "retry must NOT be deduped — previous delivery never landed"
  assert call_count["n"] == 2


@pytest.mark.asyncio
async def test_no_handler_does_not_suppress_followup_when_handler_appears():
  """If the gateway is briefly disconnected (no handler), a follow-up
  webhook with the same (position, queue_size) once the gateway
  reconnects must still be delivered.
  """

  tracker = _make_tracker_with_session("sess-Z", "chat-z@s.whatsapp.net")
  server = SubAgentWebhookServer(tracker, port=0)
  # No handler on first call (gateway disconnected window).
  resp1 = await server._handle_callback(_FakeRequest({
    "type": "queued",
    "session_id": "sess-Z",
    "position": 1,
    "queue_size": 1,
  }))
  assert resp1.status == 200

  # Gateway reconnects and registers a handler.
  handler = AsyncMock()
  server.set_queue_handler(handler)
  resp2 = await server._handle_callback(_FakeRequest({
    "type": "queue_status",
    "session_id": "sess-Z",
    "position": 1,
    "queue_size": 1,
  }))
  assert resp2.status == 200
  handler.assert_awaited_once_with("chat-z@s.whatsapp.net", "queue_status", 1, 1)


@pytest.mark.asyncio
async def test_clear_queue_handler_if_only_clears_on_identity_match():
  """Regression: an old gateway connection's ``finally`` block must
  not wipe a *newer* connection's handler. The identity-checked clear
  is the contract main.py relies on.
  """
  tracker = SubTaskTracker()
  server = SubAgentWebhookServer(tracker, port=0)

  async def handler_a(c, t, p, q):  # noqa: ANN001
    return None

  async def handler_b(c, t, p, q):  # noqa: ANN001
    return None

  server.set_queue_handler(handler_a)
  # New connection takes over.
  server.set_queue_handler(handler_b)
  # Old connection's finally fires now. It must NOT clear handler_b.
  assert server.clear_queue_handler_if(handler_a) is False
  assert server._queue_handler is handler_b
  # New connection's finally fires legitimately.
  assert server.clear_queue_handler_if(handler_b) is True
  assert server._queue_handler is None


@pytest.mark.asyncio
async def test_get_chat_for_session_returns_none_after_finalize():
  tracker = _make_tracker_with_session("sess-G", "chat-gary")
  assert tracker.get_chat_for_session("sess-G") == "chat-gary"
  tracker.finalize("sess-G", {"success": True, "report": "done"})
  assert tracker.get_chat_for_session("sess-G") is None


@pytest.mark.asyncio
async def test_request_entity_too_large_returns_413():
  """When aiohttp raises HTTPRequestEntityTooLarge (body exceeds client_max_size),
  _handle_callback must return 413, not 400."""
  from aiohttp import web as aiohttp_web

  class _TooBigRequest:
    async def json(self):
      raise aiohttp_web.HTTPRequestEntityTooLarge(max_size=200 * 1024 * 1024, actual_size=300 * 1024 * 1024)

  tracker = SubTaskTracker()
  server = SubAgentWebhookServer(tracker, port=0)
  resp = await server._handle_callback(_TooBigRequest())
  assert resp.status == 413


def test_client_max_size_default_is_200mb(monkeypatch):
  """Without any env override, _client_max_size defaults to 200 MB."""
  monkeypatch.delenv("SUBAGENT_WEBHOOK_MAX_BODY_BYTES", raising=False)
  tracker = SubTaskTracker()
  server = SubAgentWebhookServer(tracker, port=0)
  assert server._client_max_size == 200 * 1024 * 1024


def test_client_max_size_from_env(monkeypatch):
  """SUBAGENT_WEBHOOK_MAX_BODY_BYTES env var overrides the default."""
  monkeypatch.setenv("SUBAGENT_WEBHOOK_MAX_BODY_BYTES", "10485760")
  tracker = SubTaskTracker()
  server = SubAgentWebhookServer(tracker, port=0)
  assert server._client_max_size == 10485760
