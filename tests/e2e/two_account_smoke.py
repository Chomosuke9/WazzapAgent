#!/usr/bin/env python3
"""tests/e2e/two_account_smoke.py — scripted two-account end-to-end smoke.

Automated proof of the reversed multi-account topology (CONTRACT.md §1/§4/§8):

  * Node SERVES, Python WaSocket clients DIAL. Here a stub Node server stands in
    for the real `migration/node/server/wsServer.ts` because this sandbox has NO
    real WhatsApp pairing and NO LLM credentials (see tests/e2e/two-account.md).
  * Two `WaSocket` + `AgentSession` pairs, each bound to a DISTINCT tenant
    `folder_path`, each dial their OWN stub Node server and reach `ready`
    (hello → hello_ack handshake, CONTRACT §1.1).
  * Per-tenant DB isolation: a settings write made "as account A" lands only in
    `A/db/settings.db`; one made "as account B" lands only in `B/db/settings.db`
    — NO cross-talk (CONTRACT §8 per-tenant DBs).
  * Per-account message routing isolation: an `incoming_message` pushed to each
    account is delivered ONLY to that account's socket — no cross-talk.
  * `build_session` assigns each account a distinct `base + index` sub-agent
    webhook port (index 0 keeps the configured base).

NO-HANG DISCIPLINE (a prior step hung for hours):
  * NOT pytest — driven by `asyncio.run` under a hard `wait_for` ceiling.
  * Every await is bounded; all run tasks + stub servers torn down in `finally`.
  * Sockets use a far-future heartbeat + tiny reconnect base; ephemeral ports.
  * Intended to be invoked under `timeout --signal=KILL N` by CI / the operator.

Run:
    timeout --signal=KILL 60 python3 tests/e2e/two_account_smoke.py
Exit code 0 == all assertions passed.
"""
from __future__ import annotations

import asyncio
import sqlite3
import sys
import tempfile
from pathlib import Path

# --- import wiring: locate migration/python + its tests dir (for the stub) ---
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_MIGRATION_PY = _REPO_ROOT / "migration" / "python"
_MIGRATION_TESTS = _MIGRATION_PY / "tests"
sys.path.insert(0, str(_MIGRATION_PY))      # wasocket / bridge packages
sys.path.insert(0, str(_MIGRATION_TESTS))   # stub_node_server

from wasocket import make_wa_socket  # noqa: E402
from bridge import db as db_mod  # noqa: E402
from bridge.session import AgentSession  # noqa: E402
from bridge.accounts import AccountConfig  # noqa: E402
from bridge.main import build_session  # noqa: E402
from bridge.subagent.config import SUBAGENT_WEBHOOK_PORT  # noqa: E402
from stub_node_server import StubNodeServer  # noqa: E402

OP_TIMEOUT = 5.0
SCENARIO_TIMEOUT = 45.0


def _make_socket(folder: str):
  """A WaSocket tuned for fast, no-hang tests (tiny reconnect, far heartbeat)."""
  return make_wa_socket(
    folder,
    base_ms=10,
    max_ms=50,
    jitter_ratio=0,
    heartbeat_interval_ms=60000,
    ack_timeout=OP_TIMEOUT,
  )


def _settings_rows(folder: Path) -> dict[str, int]:
  """Open the tenant's settings.db directly (bypass caches): {chat_id: permission}."""
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


def _incoming_payload(folder: str, chat_id: str) -> dict:
  """Minimal valid incoming_message payload (CONTRACT §7)."""
  return {
    "folderPath": folder,
    "instanceId": "smoke",
    "chatId": chat_id,
    "chatName": chat_id,
    "chatType": "group",
    "messageId": f"wamid-{chat_id}",
    "contextMsgId": "000001",
    "senderId": "1@s.whatsapp.net",
    "senderRef": "u00001",
    "senderName": "Tester",
    "senderIsAdmin": False,
    "senderIsSuperAdmin": False,
    "isGroup": True,
    "botIsAdmin": False,
    "botIsSuperAdmin": False,
    "fromMe": False,
    "contextOnly": True,  # context-only: do NOT trigger the LLM pipeline
    "triggerLlm1": False,
    "timestampMs": 1,
    "messageType": "conversation",
    "text": f"hello {chat_id}",
    "attachments": [],
  }


async def _scenario() -> None:
  with tempfile.TemporaryDirectory(prefix="two_account_e2e_") as tmp:
    tmp_path = Path(tmp)
    folder_a = tmp_path / "tenantA"
    folder_b = tmp_path / "tenantB"
    chat_a = "groupA@g.us"
    chat_b = "groupB@g.us"

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
    sock_a.on("ready")(lambda _p=None: ready_a.set())
    sock_b.on("ready")(lambda _p=None: ready_b.set())

    # Per-account message capture (proves routing isolation at the transport
    # layer without invoking the LLM pipeline).
    msgs_a: list = []
    msgs_b: list = []
    sock_a.on("message")(lambda m: msgs_a.append(m.chat_id))
    sock_b.on("message")(lambda m: msgs_b.append(m.chat_id))

    stop = asyncio.Event()
    task_a = asyncio.create_task(sess_a.run(f"ws://127.0.0.1:{port_a}/ws", stop))
    task_b = asyncio.create_task(sess_b.run(f"ws://127.0.0.1:{port_b}/ws", stop))

    try:
      # 1) Both sockets complete the hello/hello_ack handshake and reach 'ready'.
      await asyncio.wait_for(ready_a.wait(), timeout=OP_TIMEOUT)
      await asyncio.wait_for(ready_b.wait(), timeout=OP_TIMEOUT)
      assert sock_a.is_connected and sock_b.is_connected
      print("[ok] both accounts booted and reached ready (hello/hello_ack)")

      # 2) Per-tenant DB isolation: write "as A" and "as B" via tenant context.
      with sess_a.tenant_db():
        db_mod.set_permission(chat_a, 3)
      with sess_b.tenant_db():
        db_mod.set_permission(chat_b, 1)

      rows_a = _settings_rows(folder_a)
      rows_b = _settings_rows(folder_b)
      assert rows_a == {chat_a: 3}, rows_a
      assert rows_b == {chat_b: 1}, rows_b
      assert chat_b not in rows_a and chat_a not in rows_b
      print("[ok] per-tenant settings.db isolation: no DB cross-talk")

      # 3) Per-account message routing isolation: push one message to each.
      await server_a.wait_connected(timeout=OP_TIMEOUT)
      await server_b.wait_connected(timeout=OP_TIMEOUT)
      await server_a.push_incoming_message(_incoming_payload(str(folder_a), chat_a))
      await server_b.push_incoming_message(_incoming_payload(str(folder_b), chat_b))

      async def _both_delivered() -> None:
        while not (msgs_a and msgs_b):
          await asyncio.sleep(0.02)

      await asyncio.wait_for(_both_delivered(), timeout=OP_TIMEOUT)
      assert msgs_a == [chat_a], msgs_a
      assert msgs_b == [chat_b], msgs_b
      assert chat_b not in msgs_a and chat_a not in msgs_b
      print("[ok] per-account message routing isolation: no message cross-talk")
    finally:
      stop.set()
      await asyncio.wait_for(
        asyncio.gather(task_a, task_b, return_exceptions=True),
        timeout=OP_TIMEOUT * 2,
      )
      await asyncio.wait_for(server_a.stop(), timeout=OP_TIMEOUT)
      await asyncio.wait_for(server_b.stop(), timeout=OP_TIMEOUT)


def _check_distinct_webhook_ports() -> None:
  """build_session gives each account base+index (index 0 == configured base)."""
  acct0 = AccountConfig(folder_path="/tenants/a", node_url="ws://x:3000")
  acct1 = AccountConfig(folder_path="/tenants/b", node_url="ws://x:3000")
  s0 = build_session(acct0, 0)
  s1 = build_session(acct1, 1)
  assert s0.subagent_webhook._port == SUBAGENT_WEBHOOK_PORT
  assert s1.subagent_webhook._port == SUBAGENT_WEBHOOK_PORT + 1
  assert s0.folder_path == "/tenants/a"
  assert s1.folder_path == "/tenants/b"
  print("[ok] build_session assigns distinct base+index webhook ports")


def main() -> int:
  try:
    _check_distinct_webhook_ports()
    asyncio.run(asyncio.wait_for(_scenario(), timeout=SCENARIO_TIMEOUT))
  except Exception as exc:  # noqa: BLE001
    print(f"[FAIL] two-account smoke failed: {exc!r}")
    import traceback

    traceback.print_exc()
    return 1
  print("\nTWO-ACCOUNT E2E SMOKE: PASS")
  return 0


if __name__ == "__main__":
  sys.exit(main())
