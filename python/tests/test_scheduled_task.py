"""Feature 5 — scheduled-task repository + ScheduledTaskRunner tests.

Discipline (matching the suite): NO pytest-asyncio — every coroutine is driven
with ``asyncio.run`` wrapped in ``asyncio.wait_for`` so a hang fails fast. All
timer tasks armed by the runner are tracked and cancelled/awaited in each
scenario so nothing leaks.
"""
from __future__ import annotations

import asyncio
import time
from collections import defaultdict, deque

from bridge.db import tenant_db_context, ScheduledTasksRepository, ScheduledTask
from bridge.agent.scheduled_task_runner import ScheduledTaskRunner


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
