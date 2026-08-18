"""Step 32 — ``AgentSession`` per-account state-isolation tests.

Constructs TWO :class:`bridge.session.AgentSession` instances over two stub
``WaSocket``s and proves their per-account agent state is fully isolated:

  (a) a ``WhatsAppMessage`` delivered to session A's ``"message"`` handler lands
      in A's ``per_chat`` history and NEVER appears in session B's history;
  (b) idle counters, reply-dedup signatures, and the pending-ack maps
      (``pending_send_request_chat`` / ``pending_subagent_attachments`` /
      ``pending_run_command_chat``) are independent per session;
  (c) the per-session sub-agent tracker / client / webhook are distinct objects.

Discipline (matching the existing suite): NO pytest-asyncio — every coroutine
is driven with :func:`asyncio.run`; waits are bounded with ``asyncio.wait_for``;
background tasks are cancelled in a ``finally`` for full teardown.

Like ``test_hydration`` / ``test_idle_trigger``, this imports the agent code via
its leaf module (``bridge.session``) rather than ``bridge.main``; ``session``
keeps PIL out of its import graph (the ``/sticker`` ``create_sticker_file``
import is lazy), so the module imports in PIL-less environments.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import bridge.agent.batch_processor as batch_processor_module
import bridge.session as session_module
from bridge.session import AgentSession
from bridge.db import is_muted, tenant_db_context
from wasocket.events import WhatsAppMessage


class StubWaSocket:
  """Minimal stand-in for ``wasocket.WaSocket`` exposing just what
  :meth:`AgentSession.register` touches: an ``on(event)`` decorator that
  records handlers and a ``folder_path`` property. Provides an async
  :meth:`emit` to drive a registered handler from the tests.
  """

  def __init__(self, folder_path: str) -> None:
    self._folder_path = folder_path
    self.handlers: dict[str, list] = {}

  @property
  def folder_path(self) -> str:
    return self._folder_path

  def on(self, event: str):
    def decorator(handler):
      self.handlers.setdefault(event, []).append(handler)
      return handler

    return decorator

  async def emit(self, event: str, payload) -> None:
    for handler in list(self.handlers.get(event, [])):
      result = handler(payload)
      if asyncio.iscoroutine(result):
        await result


class _AckBlockingWaSocket(StubWaSocket):
  """Models send_message awaiting ACK unless the bridge supplies an ID."""

  def __init__(self, folder_path: str) -> None:
    super().__init__(folder_path)
    self.sent: list[dict] = []

  async def send_message(self, chat_id: str, text: str, *, request_id=None):
    self.sent.append({"chatId": chat_id, "text": text, "requestId": request_id})
    if request_id is None:
      await asyncio.Event().wait()
    return None


class _LifecycleWaSocket(StubWaSocket):
  """Run-loop fake that exposes exactly when the gateway handshake completes."""

  def __init__(
    self,
    folder_path: str,
    events: list[str],
    *,
    whatsapp_open_on_connect: bool = True,
  ) -> None:
    super().__init__(folder_path)
    self.events = events
    self.connected = False
    self.whatsapp_open_on_connect = whatsapp_open_on_connect

  async def connect(self, _node_url: str) -> None:
    self.events.append("connect:start")
    await asyncio.sleep(0)
    self.connected = True
    self.events.append("connect:done")
    if self.whatsapp_open_on_connect:
      await self.emit(
        "status",
        {"status": "open", "reason": None, "folderPath": self.folder_path},
      )

  async def disconnect(self) -> None:
    self.connected = False
    self.events.append("disconnect")


class _LifecycleScheduledTasks:
  def __init__(self, sock: _LifecycleWaSocket, events: list[str], kind: str = "scheduled") -> None:
    self.sock = sock
    self.events = events
    self.kind = kind
    self.connected_when_rearmed = False

  def rearm_pending(self) -> None:
    self.connected_when_rearmed = self.sock.connected
    self.events.append(f"{self.kind}:rearm")


class _LifecycleDirectInvoke:
  def __init__(self, sock: _LifecycleWaSocket, events: list[str]) -> None:
    self.sock = sock
    self.events = events
    self.connected_when_started = False
    self.started = asyncio.Event()

  async def start(self) -> None:
    self.connected_when_started = self.sock.connected
    self.events.append("direct:start")
    self.started.set()

  async def stop(self) -> None:
    self.events.append("direct:stop")


class _LifecycleDashboard:
  def __init__(self, events: list[str]) -> None:
    self.events = events

  async def start_flush_loop(self) -> asyncio.Task:
    async def _wait_forever() -> None:
      await asyncio.Event().wait()

    return asyncio.create_task(_wait_forever())

  def flush_to_db(self) -> None:
    self.events.append("dashboard:flush")


def _ctx_only_payload(chat_id: str, text: str) -> dict:
  """A private-chat, context-only payload: meaningful content but does NOT
  trigger LLM1, so ``process_message_batch`` takes the context-only fast path
  (append-to-history, no LLM / DB calls) and ``flush_pending`` skips the
  debounce (private => timeout 0)."""
  return {
    "chatId": chat_id,
    "chatType": "private",
    "senderRef": "",          # empty => mute gate skipped (no DB)
    "contextOnly": True,       # => not an LLM1 trigger; mute gate skipped
    "triggerLlm1": False,
    "messageType": "conversation",
    "text": text,
    "timestampMs": 1_700_000_000_000,
  }


async def _drain(session: AgentSession, timeout: float = 5.0) -> None:
  """Await all background tasks the session has spawned (the flush worker),
  bounded so a hang can never wedge the suite."""
  pending = [t for t in list(session.tasks) if not t.done()]
  # Also drain per-chat flush tasks (stored in pending_by_chat, not in
  # session.tasks) so test assertions see the processed history.
  for pbc in session.pending_by_chat.values():
    if pbc.task is not None and not pbc.task.done():
      pending.append(pbc.task)
  if pending:
    await asyncio.wait_for(asyncio.gather(*pending, return_exceptions=True), timeout=timeout)


async def _teardown(*sessions: AgentSession) -> None:
  for session in sessions:
    for task in list(session.tasks):
      task.cancel()
    if session.tasks:
      await asyncio.gather(*session.tasks, return_exceptions=True)


# ---------------------------------------------------------------------------
# (a) message delivered to A is never visible to B
# ---------------------------------------------------------------------------

def test_message_to_session_a_never_appears_in_session_b(monkeypatch):
  # This test exercises tenant isolation, not the production DM gate. Keep it
  # hermetic when pytest is run from a deployment whose .env disables DMs.
  monkeypatch.setattr(batch_processor_module, "private_chat_enabled", lambda: True)

  async def scenario():
    sess_a = AgentSession(StubWaSocket("/tenant-a"))
    sess_b = AgentSession(StubWaSocket("/tenant-b"))
    sess_a.register()
    sess_b.register()
    try:
      chat_id = "111@s.whatsapp.net"
      payload = _ctx_only_payload(chat_id, "hello from A")
      msg = WhatsAppMessage.from_payload(payload)

      # Deliver to session A's registered "message" handler only.
      await sess_a.sock.emit("message", msg)
      await _drain(sess_a)

      # A recorded exactly the delivered message...
      a_hist = sess_a.per_chat.get(chat_id)
      assert a_hist is not None and len(a_hist) == 1
      assert a_hist[0].text == "hello from A"

      # ...and B saw nothing at all (no chat, no history).
      assert chat_id not in sess_b.per_chat
      assert len(sess_b.per_chat) == 0
    finally:
      await _teardown(sess_a, sess_b)

  asyncio.run(scenario())


def test_each_session_only_sees_its_own_traffic(monkeypatch):
  monkeypatch.setattr(batch_processor_module, "private_chat_enabled", lambda: True)

  async def scenario():
    sess_a = AgentSession(StubWaSocket("/tenant-a"))
    sess_b = AgentSession(StubWaSocket("/tenant-b"))
    sess_a.register()
    sess_b.register()
    try:
      chat = "999@s.whatsapp.net"  # same chat id on purpose: still isolated
      await sess_a.sock.emit("message", WhatsAppMessage.from_payload(_ctx_only_payload(chat, "A-only")))
      await sess_b.sock.emit("message", WhatsAppMessage.from_payload(_ctx_only_payload(chat, "B-only")))
      await _drain(sess_a)
      await _drain(sess_b)

      assert [m.text for m in sess_a.per_chat[chat]] == ["A-only"]
      assert [m.text for m in sess_b.per_chat[chat]] == ["B-only"]
    finally:
      await _teardown(sess_a, sess_b)

  asyncio.run(scenario())


# ---------------------------------------------------------------------------
# (b) idle counters / dedup signatures / pending-ack maps are independent
# ---------------------------------------------------------------------------

def test_state_containers_are_distinct_objects():
  sess_a = AgentSession(StubWaSocket("/a"))
  sess_b = AgentSession(StubWaSocket("/b"))
  # Every per-account container is a separate object per session.
  assert sess_a.per_chat is not sess_b.per_chat
  assert sess_a.per_chat_lock is not sess_b.per_chat_lock
  assert sess_a.pending_by_chat is not sess_b.pending_by_chat
  assert sess_a.idle_msg_count is not sess_b.idle_msg_count
  assert sess_a.recent_reply_signatures_by_chat is not sess_b.recent_reply_signatures_by_chat
  assert sess_a.media_paths_by_chat is not sess_b.media_paths_by_chat
  assert sess_a.pending_send_request_chat is not sess_b.pending_send_request_chat
  assert sess_a.pending_subagent_attachments is not sess_b.pending_subagent_attachments
  assert sess_a.pending_run_command_chat is not sess_b.pending_run_command_chat
  assert sess_a.tasks is not sess_b.tasks


def test_idle_counters_are_independent():
  sess_a = AgentSession(StubWaSocket("/a"))
  sess_b = AgentSession(StubWaSocket("/b"))
  sess_a.idle_msg_count["c@x"] += 7
  assert sess_a.idle_msg_count["c@x"] == 7
  assert "c@x" not in sess_b.idle_msg_count
  assert sess_b.idle_msg_count["c@x"] == 0  # defaultdict default, untouched in A
  assert sess_a.idle_msg_count["c@x"] == 7


def test_reply_dedup_signatures_are_independent():
  sess_a = AgentSession(StubWaSocket("/a"))
  sess_b = AgentSession(StubWaSocket("/b"))
  sess_a.recent_reply_signatures_by_chat["c@x"].append((1, "sig-a"))
  assert list(sess_a.recent_reply_signatures_by_chat["c@x"]) == [(1, "sig-a")]
  assert "c@x" not in sess_b.recent_reply_signatures_by_chat


def test_pending_ack_maps_are_independent():
  sess_a = AgentSession(StubWaSocket("/a"))
  sess_b = AgentSession(StubWaSocket("/b"))
  sess_a.pending_send_request_chat["req-1"] = "c@x"
  sess_a.pending_subagent_attachments["att-1"] = ("c@x", [{"path": "/f"}])
  sess_a.pending_run_command_chat["cmd-1"] = ("c@x", "/help")
  assert "req-1" not in sess_b.pending_send_request_chat
  assert "att-1" not in sess_b.pending_subagent_attachments
  assert "cmd-1" not in sess_b.pending_run_command_chat


# ---------------------------------------------------------------------------
# (c) per-session sub-agent objects
# ---------------------------------------------------------------------------

def test_subagent_objects_are_per_session():
  sess_a = AgentSession(StubWaSocket("/a"))
  sess_b = AgentSession(StubWaSocket("/b"))
  assert sess_a.subagent_tracker is not sess_b.subagent_tracker
  assert sess_a.subagent_client is not sess_b.subagent_client
  assert sess_a.subagent_webhook is not sess_b.subagent_webhook
  # A finished sub-agent task registered in A's tracker is invisible to B.
  from bridge.subagent.models import SubTask
  sess_a.subagent_tracker.register(SubTask(session_id="s1", instruction="x", chat_id="c@x"))
  assert sess_a.subagent_tracker.get_active_for_chat("c@x") is not None
  assert sess_b.subagent_tracker.get_active_for_chat("c@x") is None


# ---------------------------------------------------------------------------
# register() wiring sanity
# ---------------------------------------------------------------------------

def test_register_wires_all_expected_events():
  sess = AgentSession(StubWaSocket("/a"))
  sess.register()
  wired = set(sess.sock.handlers)
  expected = {
    "message", "status", "ready", "error", "action_ack", "send_ack",
    "clear_history", "set_llm2_model", "invalidate_llm2_model",
    "invalidate_default_model", "invalidate_chat_settings", "set_subagent_enabled",
  }
  assert expected <= wired
  assert sess._queue_handler is not None


def test_action_ack_handler_never_blocks_the_socket_frame_pump():
  """A lock-waiting hydrator must not delay a later frame for another chat."""

  async def scenario():
    sock = StubWaSocket("/a")
    session = AgentSession(sock)
    hydration_started = asyncio.Event()
    release_hydration = asyncio.Event()

    class _BlockingAckHydrator:
      async def handle(self, _ack_evt) -> None:
        hydration_started.set()
        await release_hydration.wait()

    # _register_handlers captures the collaborator, so replace it first.
    session._ack = _BlockingAckHydrator()
    session.register()

    later_frame_seen = asyncio.Event()

    @sock.on("later_frame")
    async def _on_later_frame(_payload):
      later_frame_seen.set()

    # The action_ack event must return even though hydration itself is stuck.
    await asyncio.wait_for(sock.emit("action_ack", object()), timeout=0.25)
    await asyncio.wait_for(hydration_started.wait(), timeout=0.25)
    assert release_hydration.is_set() is False

    # This models the next item in WaSocket's serialized receive loop.
    await asyncio.wait_for(sock.emit("later_frame", object()), timeout=0.25)
    assert later_frame_seen.is_set()

    release_hydration.set()
    if session.tasks:
      await asyncio.gather(*list(session.tasks))

  asyncio.run(scenario())


def test_daily_task_list_and_delete_do_not_wait_for_action_ack():
  """Control-event replies must return so the pump can read their ACKs."""

  class _DailyTasks:
    def list_for_chat(self, _chat_id):
      return [SimpleNamespace(id="abcdef12-full", time_of_day="08:00", prompt="ping")]

    def delete_for_chat(self, _chat_id, _task_id):
      task = SimpleNamespace(id="abcdef12-full")
      return "deleted", task

  async def scenario():
    sock = _AckBlockingWaSocket("/tenant-a")
    session = AgentSession(sock)
    session._daily = _DailyTasks()
    session.register()

    await asyncio.wait_for(
      sock.emit("daily_task_list", {"chatId": "123@g.us"}),
      timeout=0.25,
    )
    await asyncio.wait_for(
      sock.emit(
        "daily_task_delete",
        {"chatId": "123@g.us", "taskId": "abcdef12"},
      ),
      timeout=0.25,
    )

    assert len(sock.sent) == 2
    assert all(item["requestId"] for item in sock.sent)
    assert sock.sent[0]["requestId"].startswith("daily_task_list-")
    assert sock.sent[1]["requestId"].startswith("daily_task_delete-")
    history = session.per_chat["123@g.us"]
    assert [message.text for message in history] == [
      sock.sent[0]["text"],
      sock.sent[1]["text"],
    ]
    assert all(message.role == "assistant" for message in history)
    assert all(message.context_msg_id == "pending" for message in history)
    assert set(session.pending_send_request_chat) == {
      sock.sent[0]["requestId"],
      sock.sent[1]["requestId"],
    }

  asyncio.run(scenario())


# ---------------------------------------------------------------------------
# run() lifecycle ordering
# ---------------------------------------------------------------------------

def test_run_connects_before_rearm_and_direct_invoke_start(tmp_path, monkeypatch):
  """Cold outbound work must not become active before hello/hello_ack."""

  async def scenario():
    events: list[str] = []
    sock = _LifecycleWaSocket(str(tmp_path), events)
    session = AgentSession(sock)
    session.register()

    scheduled = _LifecycleScheduledTasks(sock, events)
    daily = _LifecycleScheduledTasks(sock, events, "daily")
    direct = _LifecycleDirectInvoke(sock, events)
    session._scheduled = scheduled
    session._daily = daily
    session._direct_invoke = direct
    session._dashboard = _LifecycleDashboard(events)

    # Keep this lifecycle test focused on ordering, not process-global DB
    # checkpoint bookkeeping performed during normal shutdown.
    monkeypatch.setattr(session_module, "db_checkpoint_all_dbs", lambda: None)
    monkeypatch.setattr(session_module, "db_close_all_connections", lambda: None)

    stop_event = asyncio.Event()
    run_task = asyncio.create_task(
      session.run("ws://node.invalid:3000", stop_event)
    )
    await asyncio.wait_for(direct.started.wait(), timeout=5.0)
    stop_event.set()
    await asyncio.wait_for(run_task, timeout=5.0)

    assert scheduled.connected_when_rearmed is True
    assert daily.connected_when_rearmed is True
    assert direct.connected_when_started is True
    assert events.index("connect:done") < events.index("scheduled:rearm")
    assert events.index("connect:done") < events.index("daily:rearm")
    assert events.index("connect:done") < events.index("direct:start")
    # The reorder remains inside run()'s existing cleanup boundary.
    assert events.index("direct:stop") < events.index("disconnect")

  asyncio.run(scenario())


def test_run_waits_for_whatsapp_open_before_cold_outbound_work(tmp_path, monkeypatch):
  """A Node handshake alone must not trigger sends from an unpaired account."""

  async def scenario():
    events: list[str] = []
    sock = _LifecycleWaSocket(
      str(tmp_path),
      events,
      whatsapp_open_on_connect=False,
    )
    session = AgentSession(sock)
    session.register()
    scheduled = _LifecycleScheduledTasks(sock, events)
    daily = _LifecycleScheduledTasks(sock, events, "daily")
    direct = _LifecycleDirectInvoke(sock, events)
    session._scheduled = scheduled
    session._daily = daily
    session._direct_invoke = direct
    session._dashboard = _LifecycleDashboard(events)

    async def recover_pending() -> None:
      events.append("recovery")

    session._subagent.recover_pending_completions = recover_pending
    monkeypatch.setattr(session_module, "db_checkpoint_all_dbs", lambda: None)
    monkeypatch.setattr(session_module, "db_close_all_connections", lambda: None)

    stop_event = asyncio.Event()
    run_task = asyncio.create_task(
      session.run("ws://node.invalid:3000", stop_event)
    )
    while "connect:done" not in events:
      await asyncio.sleep(0)
    await asyncio.sleep(0.02)
    assert "recovery" not in events
    assert "scheduled:rearm" not in events
    assert "daily:rearm" not in events
    assert "direct:start" not in events

    await sock.emit(
      "status",
      {"status": "open", "reason": None, "folderPath": sock.folder_path},
    )
    await asyncio.wait_for(direct.started.wait(), timeout=1.0)
    assert events.index("connect:done") < events.index("recovery")
    assert events.index("recovery") < events.index("scheduled:rearm")
    assert events.index("recovery") < events.index("daily:rearm")

    stop_event.set()
    await asyncio.wait_for(run_task, timeout=5.0)

  asyncio.run(scenario())


def test_set_chat_mute_event_updates_tenant_moderation_state(tmp_path):
  async def scenario():
    sock = StubWaSocket(str(tmp_path))
    session = AgentSession(sock)
    session.register()
    with tenant_db_context(str(tmp_path)):
      await sock.emit("set_chat_mute", {
        "chatId": "12345@g.us",
        "senderRef": "abc123",
        "senderName": "Alice",
        "durationMinutes": 15,
      })
      assert is_muted("12345@g.us", "abc123") is True

      await sock.emit("set_chat_mute", {
        "chatId": "12345@g.us",
        "senderRef": "abc123",
        "senderName": "Alice",
        "durationMinutes": 0,
      })
      assert is_muted("12345@g.us", "abc123") is False

  asyncio.run(scenario())
