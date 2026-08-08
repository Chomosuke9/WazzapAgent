from __future__ import annotations

import asyncio
import time
from collections import defaultdict, deque
from datetime import datetime, timezone

from bridge.agent.daily_task_runner import DailyTaskRunner, next_daily_fire_at_ms
from bridge.db import DailyTask, DailyTasksRepository, tenant_db_context


def test_next_daily_fire_respects_configured_utc_offset():
  now = datetime(2026, 8, 9, 7, 0, tzinfo=timezone.utc)
  now_ms = int(now.timestamp() * 1000)  # 14:00 at UTC+7
  same_day = next_daily_fire_at_ms("15:00", now_ms=now_ms, utc_offset_raw="7")
  next_day = next_daily_fire_at_ms("13:00", now_ms=now_ms, utc_offset_raw="7")
  assert same_day - now_ms == 60 * 60 * 1000
  assert next_day - now_ms == 23 * 60 * 60 * 1000


def test_daily_repository_roundtrip(tmp_path):
  with tenant_db_context(str(tmp_path)):
    repo = DailyTasksRepository()
    task = DailyTask("d1", "c@g.us", "08:30", "ping", 1)
    repo.add(task)
    assert repo.list_all() == [task]
    repo.delete("d1")
    assert repo.list_all() == []


class _Repo:
  def __init__(self):
    self.rows = {}

  def add(self, task):
    self.rows[task.id] = task

  def list_all(self):
    return list(self.rows.values())


class _Responder:
  def __init__(self):
    self.calls = []

  async def generate(self, history, current, **kwargs):
    self.calls.append({"history": list(history), "kwargs": kwargs})
    return None


class _Ws:
  async def send_presence(self, _chat_id, _presence):
    return None


def test_daily_runner_persists_fires_and_rearms(monkeypatch):
  async def scenario():
    import bridge.agent.daily_task_runner as daily_mod

    repo = _Repo()
    responder = _Responder()
    tasks = set()

    def track(task):
      tasks.add(task)
      task.add_done_callback(tasks.discard)

    monkeypatch.setattr(
      daily_mod,
      "next_daily_fire_at_ms",
      lambda *_a, **_k: int(time.time() * 1000) + 20,
    )
    runner = DailyTaskRunner(
      repository=repo,
      ws=_Ws(),
      responder=responder,
      per_chat=defaultdict(deque),
      per_chat_lock=defaultdict(asyncio.Lock),
      track_task=track,
      get_prompt=lambda _chat: None,
    )
    await runner.schedule({
      "chatId": "c@g.us",
      "taskId": "daily-1",
      "timeOfDay": "08:00",
      "prompt": "ping @Alice (abc123)",
    })
    deadline = time.monotonic() + 2
    while not responder.calls and time.monotonic() < deadline:
      await asyncio.sleep(0.01)
    try:
      assert "daily-1" in repo.rows  # recurring rows are not deleted after fire
      assert responder.calls
      call = responder.calls[0]
      assert call["kwargs"]["scheduled_task_block"]
      assert any("[DAILY TASK]" in (m.text or "") for m in call["history"])
    finally:
      for task in list(tasks):
        task.cancel()
      if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)

  asyncio.run(asyncio.wait_for(scenario(), timeout=5))
