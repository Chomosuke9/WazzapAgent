"""Two-account boot + per-tenant DB isolation (Step 33).

Proves the multi-account contract (CONTRACT.md §4 / §8):

  * Two ``WaSocket`` + ``AgentSession`` pairs, each for a distinct
    ``folder_path``, both dial their own stub Node server and reach ``ready``.
  * A settings write made "as account A" (inside A's tenant DB context) lands in
    ``A/db/settings.db`` and a write made "as account B" lands in
    ``B/db/settings.db`` — with NO cross-talk (each tenant DB has only its own
    chat row).
  * The Step-32 sub-agent webhook PORT COLLISION is resolved: ``build_session``
    assigns each account a distinct ``base + index`` port (index 0 keeps the
    configured base, preserving single-account behaviour).

NO-HANG DISCIPLINE (a prior step hung for hours): no pytest-asyncio — async is
driven via ``asyncio.run`` under a hard ``wait_for`` ceiling; every await is
bounded; all run tasks + stub servers are torn down in ``finally``; sockets use
a far-future heartbeat + tiny reconnect base. Ephemeral ports throughout.
"""
from __future__ import annotations

import asyncio
import sqlite3
import sys
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_TESTS_DIR.parent))  # migration/python
sys.path.insert(0, str(_TESTS_DIR))         # tests dir -> stub_node_server

from wasocket import make_wa_socket  # noqa: E402
from bridge import db as db_mod  # noqa: E402
from bridge.session import AgentSession  # noqa: E402
from bridge.accounts import AccountConfig  # noqa: E402
from bridge.main import build_session  # noqa: E402
from bridge.subagent.config import SUBAGENT_WEBHOOK_PORT  # noqa: E402
from stub_node_server import StubNodeServer  # noqa: E402

OP_TIMEOUT = 5.0
SCENARIO_TIMEOUT = 30.0


def _make_socket(folder: str):
  return make_wa_socket(
    folder,
    base_ms=10,
    max_ms=50,
    jitter_ratio=0,
    heartbeat_interval_ms=60000,
    ack_timeout=OP_TIMEOUT,
  )


def _settings_rows(folder: Path) -> dict[str, int]:
  """Open the tenant's settings.db DIRECTLY (bypassing all caches) and return
  ``{chat_id: permission}`` for non-global rows."""
  db_path = folder / "db" / "settings.db"
  assert db_path.exists(), f"expected tenant settings.db at {db_path}"
  conn = sqlite3.connect(str(db_path))
  try:
    rows = conn.execute(
      "SELECT chat_id, permission FROM chat_settings WHERE chat_id != '__global__'"
    ).fetchall()
  finally:
    conn.close()
  return {chat_id: perm for chat_id, perm in rows}


def test_two_account_boot_reaches_ready_and_isolates_dbs(tmp_path):
  folder_a = tmp_path / "tenantA"
  folder_b = tmp_path / "tenantB"
  chat_a = "groupA@g.us"
  chat_b = "groupB@g.us"

  async def scenario():
    server_a = StubNodeServer(str(folder_a))
    server_b = StubNodeServer(str(folder_b))
    port_a = await server_a.start()
    port_b = await server_b.start()

    sock_a = _make_socket(str(folder_a))
    sock_b = _make_socket(str(folder_b))
    sess_a = AgentSession(sock_a)
    sess_b = AgentSession(sock_b)
    sess_a.register()
    sess_b.register()

    ready_a = asyncio.Event()
    ready_b = asyncio.Event()
    sock_a.on("ready")(lambda _payload=None: ready_a.set())
    sock_b.on("ready")(lambda _payload=None: ready_b.set())

    stop = asyncio.Event()
    task_a = asyncio.create_task(sess_a.run(f"ws://127.0.0.1:{port_a}/ws", stop))
    task_b = asyncio.create_task(sess_b.run(f"ws://127.0.0.1:{port_b}/ws", stop))

    try:
      # 1) Both sockets reach 'ready'.
      await asyncio.wait_for(ready_a.wait(), timeout=OP_TIMEOUT)
      await asyncio.wait_for(ready_b.wait(), timeout=OP_TIMEOUT)
      assert sock_a.is_connected and sock_b.is_connected

      # 2) Simulate each session handling a message → settings write, routed
      #    through that session's per-tenant DB context.
      with sess_a.tenant_db():
        db_mod.set_permission(chat_a, 3)
      with sess_b.tenant_db():
        db_mod.set_permission(chat_b, 1)

      # 3) Each tenant DB has ONLY its own row (no cross-talk), on disk.
      rows_a = _settings_rows(folder_a)
      rows_b = _settings_rows(folder_b)
      assert rows_a == {chat_a: 3}, rows_a
      assert rows_b == {chat_b: 1}, rows_b
      assert chat_b not in rows_a
      assert chat_a not in rows_b
    finally:
      stop.set()
      await asyncio.wait_for(
        asyncio.gather(task_a, task_b, return_exceptions=True), timeout=OP_TIMEOUT * 2
      )
      await asyncio.wait_for(server_a.stop(), timeout=OP_TIMEOUT)
      await asyncio.wait_for(server_b.stop(), timeout=OP_TIMEOUT)

  asyncio.run(asyncio.wait_for(scenario(), timeout=SCENARIO_TIMEOUT))


def test_build_session_assigns_distinct_webhook_ports():
  """The per-session webhook port collision (Step 32) is resolved by giving
  each account base+index — so two sessions never bind the same port."""
  acct0 = AccountConfig(folder_path="/tenants/a", node_url="ws://x:3000")
  acct1 = AccountConfig(folder_path="/tenants/b", node_url="ws://x:3000")
  s0 = build_session(acct0, 0)
  s1 = build_session(acct1, 1)
  # index 0 keeps the configured base (single-account behaviour preserved).
  assert s0.subagent_webhook._port == SUBAGENT_WEBHOOK_PORT
  assert s1.subagent_webhook._port == SUBAGENT_WEBHOOK_PORT + 1
  assert s0.subagent_webhook._port != s1.subagent_webhook._port
  # And each session is bound to its own tenant folder.
  assert s0.folder_path == "/tenants/a"
  assert s1.folder_path == "/tenants/b"
