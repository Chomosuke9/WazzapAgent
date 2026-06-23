"""Feature 5 — scheduled-task repository + ScheduledTaskRunner tests.

Discipline (matching the suite): NO pytest-asyncio — every coroutine is driven
with ``asyncio.run`` wrapped in ``asyncio.wait_for`` so a hang fails fast. All
timer tasks armed by the runner are tracked and cancelled/awaited in each
scenario so nothing leaks.
"""
from __future__ import annotations

import asyncio
import time
from collections import OrderedDict, defaultdict, deque

from bridge.db import tenant_db_context, ScheduledTasksRepository, ScheduledTask
from bridge.agent.scheduled_task_runner import ScheduledTaskRunner
from bridge.agent.chat_reinvoker import ChatReinvoker
from bridge.messaging.ack_handler import handle_action_ack
from wasocket.protocol import AckResult


# --------------------------------------------------------------------------- #
# Repository round-trip (real per-tenant settings.db under a temp dir)
# --------------------------------------------------------------------------- #

def test_repository_add_list_delete_roundtrip(tmp_path):
  with tenant_db_context(str(tmp_path)):
    repo = ScheduledTasksRepository()
    assert repo.list_all() == []

    t1 = ScheduledTask(id="a", chat_id="c1@g.us", fire_at_ms=1000, prompt="p1", created_at_ms=10)
    t2 = ScheduledTask(id="b", chat_id="c2@g.us", fire_at_ms=500, prompt="p2", created_at_ms=20)
    repo.add(t1)
    repo.add(t2)

    rows = repo.list_all()
    # ordered by fire_at_ms ASC -> b (500) before a (1000)
    assert [r.id for r in rows] == ["b", "a"]
    assert rows[0].prompt == "p2"
    assert rows[0].chat_id == "c2@g.us"
    assert rows[1].fire_at_ms == 1000

    repo.delete("a")
    assert [r.id for r in repo.list_all()] == ["b"]
    repo.delete("b")
    assert repo.list_all() == []
    # deleting a non-existent id is a no-op
    repo.delete("nope")
    assert repo.list_all() == []


# --------------------------------------------------------------------------- #
# Fakes for the runner
# --------------------------------------------------------------------------- #

class _FakeRepo:
  def __init__(self):
    self.rows: dict[str, ScheduledTask] = {}

  def add(self, task):
    self.rows[task.id] = task

  def list_all(self):
    return list(self.rows.values())

  def delete(self, task_id):
    self.rows.pop(task_id, None)


class _FakeResponder:
  def __init__(self):
    self.calls = []

  async def generate(self, history, current, **kwargs):
    self.calls.append({"history": list(history), "current": current, "kwargs": kwargs})
    return None  # no reply_msg -> no action dispatch (keeps the test self-contained)


class _FakeWs:
  def __init__(self):
    self.presence = []

  async def send_presence(self, chat_id, presence):
    self.presence.append((chat_id, presence))


def _make_runner():
  repo = _FakeRepo()
  responder = _FakeResponder()
  ws = _FakeWs()
  per_chat = defaultdict(deque)
  per_chat_lock = defaultdict(asyncio.Lock)
  tasks: set = set()

  def track(t):
    tasks.add(t)
    t.add_done_callback(tasks.discard)

  runner = ScheduledTaskRunner(
    repository=repo,
    ws=ws,
    responder=responder,
    per_chat=per_chat,
    per_chat_lock=per_chat_lock,
    track_task=track,
    get_prompt=lambda c: None,
  )
  return runner, repo, responder, per_chat, tasks


async def _cancel_all(tasks):
  for t in list(tasks):
    t.cancel()
  if tasks:
    await asyncio.gather(*tasks, return_exceptions=True)


async def _wait_until(predicate, timeout=5.0):
  deadline = time.monotonic() + timeout
  while time.monotonic() < deadline:
    if predicate():
      return True
    await asyncio.sleep(0.02)
  return predicate()


# --------------------------------------------------------------------------- #
# schedule() -> arm -> fire -> re-invoke LLM2 -> delete row
# --------------------------------------------------------------------------- #

def test_runner_schedule_fires_invokes_responder_and_deletes_row():
  async def scenario():
    runner, repo, responder, per_chat, tasks = _make_runner()
    fire_at = int(time.time() * 1000) + 20  # ~20ms out
    frame = {"chatId": "c@g.us", "taskId": "t1", "fireAtMs": fire_at, "prompt": "remind everyone"}
    await runner.schedule(frame)
    # persisted immediately, before the timer fires
    assert "t1" in repo.rows

    fired = await _wait_until(lambda: "t1" not in repo.rows)
    try:
      assert fired, "row should be deleted after the scheduled task fires"
      assert len(responder.calls) == 1, "responder invoked exactly once"
      kwargs = responder.calls[0]["kwargs"]
      # the scheduled-task block is threaded through to LLM2
      assert kwargs.get("scheduled_task_block")
      assert "remind everyone" in kwargs["scheduled_task_block"]
      assert kwargs.get("chat_type") == "group"  # c@g.us -> group
      # the [SCHEDULED TASK] system turn was appended to history
      assert any("[SCHEDULED TASK]" in (m.text or "") for m in per_chat["c@g.us"])
    finally:
      await _cancel_all(tasks)

  asyncio.run(asyncio.wait_for(scenario(), timeout=10))


def test_runner_malformed_frame_is_dropped():
  async def scenario():
    runner, repo, responder, _per_chat, tasks = _make_runner()
    try:
      await runner.schedule({"chatId": "c@g.us", "taskId": "x"})  # no prompt
      await runner.schedule({"taskId": "y", "fireAtMs": 1, "prompt": "p"})  # no chatId
      assert repo.rows == {}
      assert responder.calls == []
    finally:
      await _cancel_all(tasks)

  asyncio.run(asyncio.wait_for(scenario(), timeout=10))


# --------------------------------------------------------------------------- #
# rearm_pending() — persisted (already past-due) rows fire on boot
# --------------------------------------------------------------------------- #

def test_runner_rearm_pending_fires_persisted_rows():
  async def scenario():
    runner, repo, responder, per_chat, tasks = _make_runner()
    # pre-existing persisted row, already past due -> should fire ASAP
    repo.rows["old"] = ScheduledTask(
      id="old",
      chat_id="dm@s.whatsapp.net",
      fire_at_ms=int(time.time() * 1000) - 5000,
      prompt="overdue task",
      created_at_ms=1,
    )
    runner.rearm_pending()

    fired = await _wait_until(lambda: "old" not in repo.rows)
    try:
      assert fired, "past-due persisted row should fire and be deleted"
      assert len(responder.calls) == 1
      assert responder.calls[0]["kwargs"].get("chat_type") == "private"  # @s.whatsapp.net
    finally:
      await _cancel_all(tasks)

  asyncio.run(asyncio.wait_for(scenario(), timeout=10))


# --------------------------------------------------------------------------- #
# Fire -> dispatch reply -> register send -> hydrate on action_ack
#
# Regression: a fired scheduled task's reply was appended to history as a
# provisional ``context_msg_id="pending"`` entry but never registered in
# ``pending_send_request_chat``, so it never hydrated to its real 6-digit id
# (unlike the sub-agent task-complete path). With the shared ChatReinvoker now
# wired to the account's pending map, the scheduled-task reply hydrates too.
# --------------------------------------------------------------------------- #

class _ReplyMsg:
  """Plain-text reply (no tool calls) -> exactly one send_message action."""

  def __init__(self, content: str):
    self.content = content
    self.tool_calls = None


class _DispatchingResponder:
  def __init__(self, reply_text: str):
    self._reply_text = reply_text
    self.calls: list = []

  async def generate(self, history, current, **kwargs):
    self.calls.append({"kwargs": kwargs})
    return _ReplyMsg(self._reply_text)


class _CapturingWs:
  def __init__(self):
    self.sent: list[dict] = []
    self.presence: list = []

  async def send_presence(self, chat_id, presence):
    self.presence.append((chat_id, presence))

  async def send_message(self, chat_id, text=None, *, reply_to=None, request_id=None, attachments=None):
    self.sent.append({
      "chat_id": chat_id, "text": text, "reply_to": reply_to, "request_id": request_id,
    })


def test_runner_fire_registers_send_and_hydrates_via_ack():
  async def scenario():
    repo = _FakeRepo()
    ws = _CapturingWs()
    responder = _DispatchingResponder("scheduled reminder fired!")
    per_chat = defaultdict(deque)
    per_chat_lock = defaultdict(asyncio.Lock)
    pending: OrderedDict = OrderedDict()
    tasks: set = set()

    def track(t):
      tasks.add(t)
      t.add_done_callback(tasks.discard)

    # The shared reinvoker is what session.py wires in production — now with the
    # account's pending_send_request_chat so sends hydrate.
    reinvoker = ChatReinvoker(
      ws=ws,
      responder=responder,
      per_chat=per_chat,
      per_chat_lock=per_chat_lock,
      get_prompt=lambda c: None,
      pending_send_request_chat=pending,
    )
    runner = ScheduledTaskRunner(
      repository=repo,
      ws=ws,
      responder=responder,
      per_chat=per_chat,
      per_chat_lock=per_chat_lock,
      track_task=track,
      get_prompt=lambda c: None,
      reinvoker=reinvoker,
    )
    chat_id = "c@g.us"
    fire_at = int(time.time() * 1000) + 20
    await runner.schedule({"chatId": chat_id, "taskId": "t1", "fireAtMs": fire_at, "prompt": "ping"})

    fired = await _wait_until(lambda: "t1" not in repo.rows)
    try:
      assert fired, "row should be deleted after the scheduled task fires"
      # The fired reply was dispatched AND registered for hydration.
      assert len(ws.sent) == 1
      rid = ws.sent[0]["request_id"]
      assert pending.get(rid) == chat_id
      prov = [m for m in per_chat[chat_id] if m.role == "assistant"]
      assert len(prov) == 1
      assert prov[0].context_msg_id == "pending"

      # action_ack hydrates the provisional id to the real 6-digit value.
      ack = AckResult(
        request_id=rid,
        action="send_message",
        ok=True,
        detail="sent",
        result={"sent": [{"kind": "text", "contextMsgId": "000777"}]},
      )
      await handle_action_ack(
        ack,
        per_chat=per_chat,
        per_chat_lock=per_chat_lock,
        pending_send_request_chat=pending,
        pending_subagent_attachments=OrderedDict(),
        pending_run_command_chat=OrderedDict(),
        media_paths_by_chat=defaultdict(dict),
      )
      assert prov[0].context_msg_id == "000777"
      assert rid not in pending
    finally:
      await _cancel_all(tasks)

  asyncio.run(asyncio.wait_for(scenario(), timeout=10))
