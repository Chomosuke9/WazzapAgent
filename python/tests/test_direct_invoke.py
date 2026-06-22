"""Direct-invoke endpoint tests — :class:`DirectInvokeServer` handler behaviour
(auth / validation / jid normalization) and the shared :class:`ChatReinvoker`
generalisation used for the ``[DIRECT INVOKE]`` re-invoke.

Discipline (matching the suite): NO pytest-asyncio — every coroutine is driven
with ``asyncio.run`` wrapped in ``asyncio.wait_for`` so a hang fails fast. The
HTTP handler is exercised with ``aiohttp.test_utils.make_mocked_request`` so no
real socket is bound.
"""
from __future__ import annotations

import asyncio
from collections import defaultdict, deque

from aiohttp.test_utils import make_mocked_request

from bridge.db import tenant_db_context
from bridge.agent.chat_reinvoker import ChatReinvoker
from bridge.agent.direct_invoke import DirectInvokeServer, normalize_jid


# --------------------------------------------------------------------------- #
# normalize_jid
# --------------------------------------------------------------------------- #

def test_normalize_jid_accepts_full_jids_and_numbers():
  assert normalize_jid("12345@g.us") == "12345@g.us"
  assert normalize_jid("628111@s.whatsapp.net") == "628111@s.whatsapp.net"
  assert normalize_jid("99999@lid") == "99999@lid"
  # bare / formatted phone numbers -> @s.whatsapp.net
  assert normalize_jid("628123") == "628123@s.whatsapp.net"
  assert normalize_jid("+62 812-345 (678)") == "62812345678@s.whatsapp.net"
  # junk / empty -> None
  assert normalize_jid("not-a-jid") is None
  assert normalize_jid("") is None
  assert normalize_jid(None) is None


# --------------------------------------------------------------------------- #
# DirectInvokeServer handler — auth / validation
# --------------------------------------------------------------------------- #

def _make_server(api_key="secret", max_chars=4000):
  calls: list[tuple[str, str]] = []

  def submit(chat_id, prompt):
    calls.append((chat_id, prompt))

  server = DirectInvokeServer(
    submit=submit, api_key=api_key, host="127.0.0.1", port=0, max_chars=max_chars,
  )
  return server, calls


async def _post(server, path, headers=None):
  request = make_mocked_request("GET", path, headers=headers or {})
  return await server._handle_post(request)


def test_handler_rejects_missing_and_wrong_key():
  async def scenario():
    server, calls = _make_server()
    # no key
    resp = await _post(server, "/post?q=hi&jid=12345@g.us")
    assert resp.status == 401
    # wrong key
    resp = await _post(server, "/post?q=hi&jid=12345@g.us&key=nope")
    assert resp.status == 401
    assert calls == []  # never submitted

  asyncio.run(asyncio.wait_for(scenario(), timeout=10))


def test_handler_disabled_when_no_api_key():
  async def scenario():
    server, calls = _make_server(api_key="")
    assert server.enabled is False
    # Even with a (any) provided key, an unconfigured server authorizes nothing.
    resp = await _post(server, "/post?q=hi&jid=12345@g.us&key=anything")
    assert resp.status == 401
    assert calls == []

  asyncio.run(asyncio.wait_for(scenario(), timeout=10))


def test_handler_validates_q_and_jid():
  async def scenario():
    server, calls = _make_server()
    # missing q
    resp = await _post(server, "/post?jid=12345@g.us&key=secret")
    assert resp.status == 400
    # blank q
    resp = await _post(server, "/post?q=%20%20&jid=12345@g.us&key=secret")
    assert resp.status == 400
    # missing jid
    resp = await _post(server, "/post?q=hi&key=secret")
    assert resp.status == 400
    # invalid jid
    resp = await _post(server, "/post?q=hi&jid=bogus&key=secret")
    assert resp.status == 400
    assert calls == []

  asyncio.run(asyncio.wait_for(scenario(), timeout=10))


def test_handler_rejects_oversized_prompt():
  async def scenario():
    server, calls = _make_server(max_chars=10)
    resp = await _post(server, "/post?q=this-is-way-too-long&jid=12345@g.us&key=secret")
    assert resp.status == 413
    assert calls == []

  asyncio.run(asyncio.wait_for(scenario(), timeout=10))


def test_handler_accepts_valid_request_and_submits():
  async def scenario():
    server, calls = _make_server()
    resp = await _post(server, "/post?q=ping%20me&jid=12345@g.us&key=secret")
    assert resp.status == 202
    assert calls == [("12345@g.us", "ping me")]

  asyncio.run(asyncio.wait_for(scenario(), timeout=10))


def test_handler_normalizes_bare_number_jid():
  async def scenario():
    server, calls = _make_server()
    resp = await _post(server, "/post?q=hello&jid=628123&key=secret")
    assert resp.status == 202
    assert calls == [("628123@s.whatsapp.net", "hello")]

  asyncio.run(asyncio.wait_for(scenario(), timeout=10))


def test_handler_accepts_key_via_headers():
  async def scenario():
    server, calls = _make_server()
    # X-Api-Key header
    resp = await _post(
      server, "/post?q=hi&jid=12345@g.us", headers={"X-Api-Key": "secret"}
    )
    assert resp.status == 202
    # Authorization: Bearer header
    resp = await _post(
      server, "/post?q=hi&jid=12345@g.us", headers={"Authorization": "Bearer secret"}
    )
    assert resp.status == 202
    assert len(calls) == 2

  asyncio.run(asyncio.wait_for(scenario(), timeout=10))


def test_disabled_server_start_is_noop():
  async def scenario():
    server, calls = _make_server(api_key="")
    # start() must be a safe no-op when disabled (fail-closed), and stop() must
    # be safe to call regardless.
    await server.start()
    assert server._site is None and server._runner is None
    await server.stop()
    assert calls == []

  asyncio.run(asyncio.wait_for(scenario(), timeout=10))


def test_endpoint_end_to_end_real_http():
  """Drive the real aiohttp request pipeline (routing + query parsing) through a
  ``TestClient`` rather than only the handler in isolation."""
  from aiohttp.test_utils import TestClient, TestServer

  async def scenario():
    server, calls = _make_server()
    client = TestClient(TestServer(server._build_app()))
    await client.start_server()
    try:
      # happy path
      resp = await client.get("/post", params={"q": "ping", "jid": "628123", "key": "secret"})
      assert resp.status == 202
      body = await resp.json()
      assert body["jid"] == "628123@s.whatsapp.net"
      # wrong key -> 401
      resp = await client.get("/post", params={"q": "ping", "jid": "628123", "key": "bad"})
      assert resp.status == 401
      # health
      resp = await client.get("/health")
      assert resp.status == 200
      assert calls == [("628123@s.whatsapp.net", "ping")]
    finally:
      await client.close()

  asyncio.run(asyncio.wait_for(scenario(), timeout=15))


def test_endpoint_post_json_body():
  """POST callers may send q/jid/key in a JSON body (documented convenience)."""
  from aiohttp.test_utils import TestClient, TestServer

  async def scenario():
    server, calls = _make_server()
    client = TestClient(TestServer(server._build_app()))
    await client.start_server()
    try:
      resp = await client.post(
        "/post", json={"q": "from body", "jid": "12345@g.us", "key": "secret"}
      )
      assert resp.status == 202
      assert calls == [("12345@g.us", "from body")]
    finally:
      await client.close()

  asyncio.run(asyncio.wait_for(scenario(), timeout=15))


# --------------------------------------------------------------------------- #
# ChatReinvoker — direct-invoke labels
# --------------------------------------------------------------------------- #

class _FakeResponder:
  def __init__(self):
    self.calls = []

  async def generate(self, history, current, **kwargs):
    self.calls.append({"history": list(history), "current": current, "kwargs": kwargs})
    return None  # no reply -> no dispatch, reinvoke returns False


class _FakeWs:
  def __init__(self):
    self.presence = []

  async def send_presence(self, chat_id, presence):
    self.presence.append((chat_id, presence))


def test_reinvoker_injects_direct_invoke_system_turn_and_block(tmp_path):
  async def scenario():
    with tenant_db_context(str(tmp_path)):
      responder = _FakeResponder()
      per_chat = defaultdict(deque)
      per_chat_lock = defaultdict(asyncio.Lock)
      reinvoker = ChatReinvoker(
        ws=_FakeWs(),
        responder=responder,
        per_chat=per_chat,
        per_chat_lock=per_chat_lock,
        get_prompt=lambda c: None,
      )
      chat_id = "628999@s.whatsapp.net"
      result = await reinvoker.reinvoke(
        chat_id,
        "ping me from my watch",
        system_label="DIRECT INVOKE",
        block_title="Direct instruction firing now",
        block_instructions="Instructions for this re-invoke:\n- do it now.",
        log_kind="direct invoke",
      )
      # No reply produced -> False, but the model WAS invoked with the block.
      assert result is False
      assert len(responder.calls) == 1
      kwargs = responder.calls[0]["kwargs"]
      block = kwargs["scheduled_task_block"]
      assert "## Direct instruction firing now" in block
      assert "[DIRECT INVOKE]" in block
      assert "ping me from my watch" in block
      assert kwargs["chat_type"] == "private"  # @s.whatsapp.net
      # the [DIRECT INVOKE] #system turn was appended to history
      sys_turns = [m for m in per_chat[chat_id] if m.role == "system"]
      assert sys_turns and "[DIRECT INVOKE]" in (sys_turns[-1].text or "")

  asyncio.run(asyncio.wait_for(scenario(), timeout=10))
