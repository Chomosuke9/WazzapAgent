"""Bridge-side test: steering a running sub-agent now forwards files.

Before this change, ``SubAgentCoordinator.submit_subtask`` forwarded only the
instruction text when an execute_subtask call hit an already-running task
(steering) — any ``context_msg_ids`` the model passed were silently dropped, so
a file sent mid-task never reached the sub-agent. This test drives the steering
branch and asserts the resolved files are handed to ``SubAgentClient.steer``.

Discipline (matching the suite): NO pytest-asyncio — the coroutine is driven
with :func:`asyncio.run`.
"""
from __future__ import annotations

import asyncio
import os

from bridge.session import AgentSession
from bridge.agent.subagent_coordinator import SubAgentCoordinator
from bridge.subagent.models import SubTask
from bridge.history import WhatsAppMessage


class _StubSock:
  """Minimal WaSocket stand-in: AgentSession.__init__ only needs
  ``folder_path`` (and an ``on`` decorator if register() were called)."""

  def __init__(self, folder_path: str = "/a") -> None:
    self._folder_path = folder_path
    self.handlers: dict = {}

  @property
  def folder_path(self) -> str:
    return self._folder_path

  def on(self, event: str):
    def deco(handler):
      self.handlers.setdefault(event, []).append(handler)
      return handler
    return deco


class _RecordingClient:
  """Captures steer() arguments instead of hitting HTTP."""

  def __init__(self) -> None:
    self.calls: list[tuple] = []

  async def steer(self, session_id, instruction, input_files=None):
    self.calls.append((session_id, instruction, list(input_files or [])))
    return True


def test_steering_forwards_resolved_context_files(tmp_path, monkeypatch):
  # Redirect cross-process input staging into tmp so we don't write to the
  # repo's default data/subagent_in.
  monkeypatch.setenv("SUBAGENT_INPUT_STAGING_DIR", str(tmp_path / "staging"))

  sess = AgentSession(_StubSock("/a"))
  chat_id = "c@x"

  # An active task for this chat → execute_subtask becomes steering.
  sess.subagent_tracker.register(
    SubTask(session_id="sess-1", instruction="draw a dog", chat_id=chat_id)
  )

  # A real document already materialized on disk for ctx id 000123.
  doc = tmp_path / "report.pdf"
  doc.write_bytes(b"%PDF-1.4 hello")
  sess.media_paths_by_chat[chat_id] = {
    "000123": [{
      "path": str(doc),
      "kind": "document",
      "mime": "application/pdf",
      "fileName": "report.pdf",
    }],
  }

  recording = _RecordingClient()
  sess.subagent_client = recording

  coord = SubAgentCoordinator(sess)
  history = [
    WhatsAppMessage(timestamp_ms=0, sender="Agus", context_msg_id="000123", media="document", text="report.pdf"),
  ]
  action = {
    "instruction": "use this PDF, keep everything else the same",
    "contextMsgIds": ["000123"],
    "high_quality": False,
  }

  asyncio.run(coord.submit_subtask(
    action=action,
    chat_id=chat_id,
    history=history,
    lock=asyncio.Lock(),
    current=None,
    llm2_payload={},
    group_description=None,
    db_prompt=None,
    chat_type="private",
    bot_is_admin=False,
    bot_is_super_admin=False,
    fallback_reply_to=None,
    allowed_context_ids={"000123"},
  ))

  # steer() was called once, for the active session, WITH files.
  assert len(recording.calls) == 1
  session_id, instruction, files = recording.calls[0]
  assert session_id == "sess-1"
  assert instruction == "use this PDF, keep everything else the same"
  # The real media is staged. Its caption/filename is deliberately NOT turned
  # into a placeholder text file that could mask a missing PDF.
  assert files, "steering must forward resolved input files"
  assert all(os.path.isfile(p) for p in files)
  assert any(p.endswith(".pdf") for p in files)
  assert not any(p.endswith(".txt") for p in files)


def test_steering_without_ctx_ids_forwards_no_files(tmp_path, monkeypatch):
  monkeypatch.setenv("SUBAGENT_INPUT_STAGING_DIR", str(tmp_path / "staging"))
  sess = AgentSession(_StubSock("/a"))
  chat_id = "c@x"
  sess.subagent_tracker.register(
    SubTask(session_id="sess-2", instruction="draw a dog", chat_id=chat_id)
  )
  recording = _RecordingClient()
  sess.subagent_client = recording
  coord = SubAgentCoordinator(sess)

  asyncio.run(coord.submit_subtask(
    action={"instruction": "make it blue", "contextMsgIds": [], "high_quality": False},
    chat_id=chat_id,
    history=[],
    lock=asyncio.Lock(),
    current=None,
    llm2_payload={},
    group_description=None,
    db_prompt=None,
    chat_type="private",
    bot_is_admin=False,
    bot_is_super_admin=False,
    fallback_reply_to=None,
    allowed_context_ids=set(),
  ))

  assert len(recording.calls) == 1
  session_id, instruction, files = recording.calls[0]
  assert session_id == "sess-2"
  assert instruction == "make it blue"
  assert files == []


def test_client_steer_puts_files_and_base64_on_the_wire(tmp_path, monkeypatch):
  """SubAgentClient.steer must send both input_files (paths) and
  input_files_content (base64) so a cross-machine sub-agent can receive the
  bytes — mirroring submit()."""
  import bridge.subagent.client as client_mod
  from bridge.subagent.client import SubAgentClient

  f = tmp_path / "note.txt"
  f.write_bytes(b"steered bytes")

  captured: dict = {}

  class _Resp:
    def __init__(self, status_code, body):
      self.status_code = status_code
      self._body = body
    headers: dict = {}
    text = ""

    def json(self):
      return self._body

  def _fake_post(url, json=None, timeout=None):
    captured["url"] = url
    captured["payload"] = json
    import hashlib
    return _Resp(202, {
      "accepted": True,
      "state": "queued",
      "session_id": "sess-x",
      "steering_id": json["steering_id"],
      "requested_file_count": 1,
      "staged_file_count": 1,
      "staged_files": [{
        "name": "note.txt",
        "size": len(b"steered bytes"),
        "sha256": hashlib.sha256(b"steered bytes").hexdigest(),
      }],
      "file_errors": [],
    })

  def _fake_get(url, timeout=None):
    return _Resp(200, {
      "success": True,
      "session_id": "sess-x",
      "steering_id": captured["payload"]["steering_id"],
      "state": "consumed",
    })

  monkeypatch.setattr(client_mod, "requests", type("R", (), {
    "post": staticmethod(_fake_post), "get": staticmethod(_fake_get),
  }))

  client = SubAgentClient(base_url="http://sub", webhook_url="http://wh")

  async def _run():
    return await client.steer("sess-x", "use this", input_files=[str(f)])

  ack = asyncio.run(_run())
  assert ack["consume_status"]["state"] == "consumed"
  payload = captured["payload"]
  assert captured["url"].endswith("/steer")
  assert payload["session_id"] == "sess-x"
  assert payload["instruction"] == "use this"
  assert payload["input_files"] == [str(f)]
  # base64-inlined content for cross-machine transfer
  content = payload["input_files_content"]
  assert len(content) == 1
  assert content[0]["name"] == "note.txt"
  import base64
  assert base64.b64decode(content[0]["content_base64"]) == b"steered bytes"


def test_client_steer_without_files_omits_file_keys(monkeypatch):
  """A plain steer (no files) must not add input_files keys — preserves the
  original wire format for the common case."""
  import bridge.subagent.client as client_mod
  from bridge.subagent.client import SubAgentClient

  captured: dict = {}

  class _Resp:
    def __init__(self, status_code, body):
      self.status_code = status_code
      self._body = body
    headers: dict = {}
    text = ""

    def json(self):
      return self._body

  def _fake_post(url, json=None, timeout=None):
    captured["payload"] = json
    return _Resp(202, {
      "accepted": True,
      "state": "queued",
      "session_id": "sess-x",
      "steering_id": json["steering_id"],
      "requested_file_count": 0,
      "staged_file_count": 0,
      "staged_files": [],
      "file_errors": [],
    })

  def _fake_get(url, timeout=None):
    return _Resp(200, {
      "success": True,
      "session_id": "sess-x",
      "steering_id": captured["payload"]["steering_id"],
      "state": "consumed",
    })

  monkeypatch.setattr(client_mod, "requests", type("R", (), {
    "post": staticmethod(_fake_post), "get": staticmethod(_fake_get),
  }))
  client = SubAgentClient(base_url="http://sub", webhook_url="http://wh")
  asyncio.run(client.steer("sess-x", "focus on cats"))
  payload = captured["payload"]
  assert payload["session_id"] == "sess-x"
  assert payload["instruction"] == "focus on cats"
  assert payload["steering_id"]
  assert "input_files" not in payload
  assert "input_files_content" not in payload
