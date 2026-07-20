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

import asyncio
import hashlib
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

  def __init__(self, payload: dict, headers: dict | None = None) -> None:
    self._payload = payload
    self.headers = headers or {}

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
async def test_queue_webhook_signals_progress_keepalive():
  tracker = _make_tracker_with_session("sess-keepalive", "chat@g.us")
  server = SubAgentWebhookServer(tracker, port=0)
  server.set_queue_handler(AsyncMock())
  keepalive = asyncio.Event()
  server.register_progress_event("sess-keepalive", keepalive)

  response = await server._handle_callback(_FakeRequest({
    "type": "queued",
    "session_id": "sess-keepalive",
    "position": 2,
    "queue_size": 3,
  }))

  assert response.status == 200
  assert keepalive.is_set()


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
async def test_unknown_completion_is_deferred_and_not_acknowledged_as_delivered():
  tracker = SubTaskTracker()
  server = SubAgentWebhookServer(tracker, port=0)
  result = {"success": True, "report": "recovered"}

  response = await server._handle_callback(_FakeRequest({
    "type": "complete", "session_id": "early", "result": result,
  }))
  assert response.status == 409

  # Registration replays the retained completion; completion-event
  # registration observes it and wakes immediately.
  assert tracker.register(SubTask(
    session_id="early", chat_id="chat@g.us", instruction="work",
  )) is True
  event = asyncio.Event()
  server.register_completion_event("early", event)
  assert event.is_set()


@pytest.mark.asyncio
async def test_restart_completion_retries_until_recovery_handler_delivers():
  tracker = _make_tracker_with_session("recovered", "chat-recovered@g.us")
  server = SubAgentWebhookServer(tracker, port=0)
  payload = {
    "type": "complete",
    "session_id": "recovered",
    "result": {"success": True, "report": "done"},
  }

  not_ready = await server._handle_callback(_FakeRequest(payload))
  assert not_ready.status == 503

  recovery = AsyncMock()
  server.set_completion_recovery_handler(recovery)
  delivered = await server._handle_callback(_FakeRequest(payload))
  duplicate = await server._handle_callback(_FakeRequest(payload))

  assert delivered.status == 200
  assert duplicate.status == 200
  recovery.assert_awaited_once_with("chat-recovered@g.us", "recovered")
  assert tracker.is_delivered("recovered")


@pytest.mark.asyncio
async def test_callback_retry_owned_by_live_waiter_does_not_recover_duplicate():
  tracker = _make_tracker_with_session("live", "chat-live@g.us")
  server = SubAgentWebhookServer(tracker, port=0)
  event = asyncio.Event()
  server.register_completion_event("live", event)
  recovery = AsyncMock()
  server.set_completion_recovery_handler(recovery)
  payload = {
    "type": "complete", "session_id": "live",
    "result": {"success": True, "report": "done"},
  }

  first = await server._handle_callback(_FakeRequest(payload))
  retry = await server._handle_callback(_FakeRequest(payload))

  assert first.status == retry.status == 200
  assert event.is_set()
  recovery.assert_not_awaited()


@pytest.mark.asyncio
async def test_callback_shared_secret_is_enforced(monkeypatch):
  monkeypatch.setenv("SUBAGENT_WEBHOOK_TOKEN", "correct-secret")
  tracker = _make_tracker_with_session("secure", "chat@g.us")
  server = SubAgentWebhookServer(tracker, port=0)

  denied = await server._handle_callback(_FakeRequest({
    "type": "progress", "session_id": "secure", "entry": {"step": "x"},
  }))
  allowed = await server._handle_callback(_FakeRequest(
    {"type": "progress", "session_id": "secure", "entry": {"step": "x"}},
    {"X-Subagent-Webhook-Token": "correct-secret"},
  ))

  assert denied.status == 401
  assert allowed.status == 200


@pytest.mark.asyncio
async def test_omitted_output_is_streamed_with_separate_api_token(
  tmp_path, monkeypatch,
):
  from aiohttp import web
  import bridge.subagent.webhook_server as webhook_module

  content = b"durable cross-host output"
  digest = hashlib.sha256(content).hexdigest()
  observed: dict[str, str] = {}

  async def download(request):
    observed["authorization"] = request.headers.get("Authorization", "")
    if observed["authorization"] != "Bearer api-secret":
      return web.Response(status=401)
    return web.Response(body=content, headers={"X-Content-SHA256": digest})

  app = web.Application()
  app.router.add_get("/sessions/large/outputs/file-1", download)
  runner = web.AppRunner(app)
  await runner.setup()
  site = web.TCPSite(runner, "127.0.0.1", 0)
  await site.start()
  sockets = site._server.sockets
  port = sockets[0].getsockname()[1]
  monkeypatch.setattr(webhook_module, "SUBAGENT_URL", f"http://127.0.0.1:{port}")
  monkeypatch.setenv("SUBAGENT_API_TOKEN", "api-secret")
  monkeypatch.setenv("SUBAGENT_WEBHOOK_TOKEN", "callback-secret")

  tracker = SubTaskTracker(state_path=tmp_path / "tracker.json")
  tracker.register(SubTask(
    session_id="large", chat_id="chat@g.us", instruction="make output",
  ))
  server = SubAgentWebhookServer(tracker, port=0)
  completion = asyncio.Event()
  server.register_completion_event("large", completion)
  payload = {
    "type": "complete",
    "session_id": "large",
    "result": {
      "success": True,
      "report": "done",
      "output_files_content": [{
        "file_id": "file-1",
        "name": "report.pdf",
        "size_bytes": len(content),
        "sha256": digest,
        "download_url": "/sessions/large/outputs/file-1",
      }],
    },
  }
  try:
    response = await server._handle_callback(_FakeRequest(
      payload, {"X-Subagent-Webhook-Token": "callback-secret"},
    ))
  finally:
    await runner.cleanup()

  assert response.status == 200
  assert completion.is_set()
  assert observed["authorization"] == "Bearer api-secret"
  finished = tracker.get_finished("large")
  assert finished is not None
  local_path = Path(finished.result["output_files_content"][0]["local_path"])
  assert local_path.read_bytes() == content
  # Callback and API credentials are deliberately independent.
  assert observed["authorization"] != "Bearer callback-secret"


@pytest.mark.asyncio
async def test_output_download_checksum_failure_is_retryable(
  tmp_path, monkeypatch,
):
  from aiohttp import web
  import bridge.subagent.webhook_server as webhook_module

  content = b"corrupt in transit"

  async def download(_request):
    return web.Response(body=content)

  app = web.Application()
  app.router.add_get("/sessions/bad/outputs/file-2", download)
  runner = web.AppRunner(app)
  await runner.setup()
  site = web.TCPSite(runner, "127.0.0.1", 0)
  await site.start()
  port = site._server.sockets[0].getsockname()[1]
  monkeypatch.setattr(webhook_module, "SUBAGENT_URL", f"http://127.0.0.1:{port}")

  tracker = SubTaskTracker(state_path=tmp_path / "tracker.json")
  tracker.register(SubTask(
    session_id="bad", chat_id="chat@g.us", instruction="make output",
  ))
  server = SubAgentWebhookServer(tracker, port=0)
  payload = {
    "type": "complete",
    "session_id": "bad",
    "result": {
      "success": True,
      "output_files_content": [{
        "file_id": "file-2",
        "name": "bad.bin",
        "size_bytes": len(content),
        "sha256": hashlib.sha256(b"expected bytes").hexdigest(),
        "download_url": "/sessions/bad/outputs/file-2",
      }],
    },
  }
  try:
    response = await server._handle_callback(_FakeRequest(payload))
  finally:
    await runner.cleanup()

  assert response.status == 502
  assert tracker.get_chat_for_session("bad") == "chat@g.us"
  assert tracker.get_finished("bad") is None
  assert not list(tmp_path.rglob("*.download"))


@pytest.mark.asyncio
async def test_verified_shared_output_path_avoids_network_download(
  tmp_path, monkeypatch,
):
  import bridge.subagent.webhook_server as webhook_module

  content = b"shared filesystem output"
  source = tmp_path / "receiver" / "opaque-file"
  source.parent.mkdir()
  source.write_bytes(content)
  monkeypatch.setattr(webhook_module, "SUBAGENT_URL", "http://127.0.0.1:1")
  monkeypatch.delenv("SUBAGENT_API_TOKEN", raising=False)
  tracker = SubTaskTracker(state_path=tmp_path / "tracker.json")
  server = SubAgentWebhookServer(tracker, port=0)

  hydrated = await server._materialize_downloadable_outputs("shared", {
    "output_files_content": [{
      "file_id": "shared-1",
      "name": "original-name.txt",
      "path": str(source),
      "size_bytes": len(content),
      "sha256": hashlib.sha256(content).hexdigest(),
      "download_url": "/sessions/shared/outputs/shared-1",
    }],
  })

  assert hydrated["output_files_content"][0]["local_path"] == str(source.resolve())


@pytest.mark.asyncio
async def test_persistent_start_propagates_initial_bind_failure(monkeypatch):
  tracker = SubTaskTracker()
  server = SubAgentWebhookServer(tracker, port=0)
  start = AsyncMock(side_effect=OSError("port already in use"))
  monkeypatch.setattr(server, "start", start)

  with pytest.raises(OSError, match="port already in use"):
    await server.start_persistent()
  assert server._keeper_task is None


@pytest.mark.asyncio
async def test_non_loopback_webhook_bind_requires_shared_secret(monkeypatch):
  monkeypatch.setenv("SUBAGENT_WEBHOOK_HOST", "0.0.0.0")
  monkeypatch.delenv("SUBAGENT_WEBHOOK_TOKEN", raising=False)
  server = SubAgentWebhookServer(SubTaskTracker(), port=0)

  with pytest.raises(RuntimeError, match="SUBAGENT_WEBHOOK_TOKEN is required"):
    await server.start()
  assert server._runner is None
  assert server._site is None


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
