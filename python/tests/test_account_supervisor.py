from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bridge.account_supervisor import AccountSupervisor, assign_account_slots  # noqa: E402
from bridge.accounts import AccountConfig  # noqa: E402


class FakeWebhook:
  def __init__(self):
    self.started = False
    self.stopped = False

  async def start_persistent(self):
    self.started = True

  async def stop_persistent(self):
    self.stopped = True


class FakeSession:
  def __init__(self, folder_path: str):
    self.folder_path = folder_path
    self.subagent_webhook = FakeWebhook()
    self.run_started = asyncio.Event()
    self.run_stopped = asyncio.Event()

  async def run(self, _node_url: str, stop_event: asyncio.Event):
    self.run_started.set()
    try:
      await stop_event.wait()
    finally:
      self.run_stopped.set()


def account(folder: Path, *, slot: int | None = None, node_url: str = "ws://node:3000"):
  return AccountConfig(str(folder.resolve()), node_url, slot)


def test_slot_assignment_preserves_live_unpinned_accounts_and_honours_pins(tmp_path):
  a = account(tmp_path / "a")
  b = account(tmp_path / "b")
  c = account(tmp_path / "c", slot=0)
  planned = assign_account_slots([a, b, c], {a.folder_path: 0, b.folder_path: 5})
  assert [(item.folder_path, slot) for item, slot in planned] == [
    (a.folder_path, 1),
    (b.folder_path, 5),
    (c.folder_path, 0),
  ]


def test_supervisor_hot_adds_and_removes_sessions_without_restarting_others(tmp_path):
  async def scenario():
    configs = [account(tmp_path / "a"), account(tmp_path / "b")]
    built: list[tuple[str, int, FakeSession]] = []

    def builder(config: AccountConfig, slot: int):
      session = FakeSession(config.folder_path)
      built.append((config.folder_path, slot, session))
      return session

    supervisor = AccountSupervisor(
      loader=lambda: list(configs),
      session_builder=builder,
      callback_url_for_slot=lambda slot: f"http://localhost:{8081 + slot}/callback",
      poll_interval=0.01,
      stop_timeout=0.2,
    )
    global_stop = asyncio.Event()
    task = asyncio.create_task(supervisor.run(global_stop))
    try:
      for _ in range(100):
        if len(supervisor.running) == 2:
          break
        await asyncio.sleep(0.01)
      assert set(supervisor.running) == {configs[0].folder_path, configs[1].folder_path}
      original_b = supervisor.running[configs[1].folder_path]

      removed = configs[0]
      added = account(tmp_path / "c")
      configs[:] = [configs[1], added]
      for _ in range(100):
        if set(supervisor.running) == {configs[0].folder_path, added.folder_path}:
          break
        await asyncio.sleep(0.01)

      assert removed.folder_path not in supervisor.running
      assert supervisor.running[configs[0].folder_path] is original_b
      assert supervisor.running[configs[0].folder_path].slot == 1
      assert supervisor.running[added.folder_path].slot == 0
      removed_session = next(item[2] for item in built if item[0] == removed.folder_path)
      assert removed_session.subagent_webhook.stopped is True
      assert removed_session.run_stopped.is_set()
    finally:
      global_stop.set()
      await asyncio.wait_for(task, timeout=1)
    assert supervisor.running == {}

  asyncio.run(scenario())


def test_supervisor_rejects_duplicate_callback_routes_before_starting(tmp_path):
  sessions: list[FakeSession] = []

  def builder(config: AccountConfig, _slot: int):
    session = FakeSession(config.folder_path)
    sessions.append(session)
    return session

  supervisor = AccountSupervisor(
    loader=lambda: [],
    session_builder=builder,
    callback_url_for_slot=lambda _slot: "https://example.invalid/callback",
  )
  with pytest.raises(ValueError, match="Duplicate sub-agent callback URL"):
    asyncio.run(supervisor.reconcile([account(tmp_path / "a"), account(tmp_path / "b")]))
  assert sessions == []


def test_supervisor_cleans_up_a_partially_started_webhook(tmp_path):
  class FailingWebhook(FakeWebhook):
    async def start_persistent(self):
      self.started = True
      raise OSError("port busy")

  session = FakeSession(str(tmp_path / "a"))
  session.subagent_webhook = FailingWebhook()
  supervisor = AccountSupervisor(
    loader=lambda: [],
    session_builder=lambda _config, _slot: session,
    callback_url_for_slot=lambda slot: f"http://localhost:{8081 + slot}/callback",
  )
  with pytest.raises(OSError, match="port busy"):
    asyncio.run(supervisor.reconcile([account(tmp_path / "a")]))
  assert session.subagent_webhook.stopped is True
  assert supervisor.running == {}
