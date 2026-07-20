"""Regression tests for fail-closed main-agent to sub-agent file ingress."""
from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path

import pytest

from bridge.agent.subagent_coordinator import (
  SubAgentInputError,
  _resolve_ctx_ids_to_input_files,
)
from bridge.history import WhatsAppMessage
from bridge.subagent.client import SubAgentClient, SubAgentSubmitError


class _DownloadSock:
  def __init__(self, *, result=None, error=None):
    self.result = result
    self.error = error
    self.calls = []

  async def download_media(self, chat_id, **kwargs):
    self.calls.append((chat_id, kwargs))
    if self.error is not None:
      raise self.error
    return self.result


def _history(cid: str, *, media="document", text="report.pdf"):
  return [WhatsAppMessage(
    timestamp_ms=0,
    sender="user",
    context_msg_id=cid,
    media=media,
    text=text,
  )]


def test_resolver_stages_every_attachment_without_caption_placeholder(tmp_path, monkeypatch):
  monkeypatch.setenv("SUBAGENT_INPUT_STAGING_DIR", str(tmp_path / "staging"))
  first = tmp_path / "first.pdf"
  second = tmp_path / "second.csv"
  first.write_bytes(b"pdf")
  second.write_bytes(b"csv")
  store = {"chat": {"000123": [
    {"path": str(first), "kind": "document"},
    {"path": str(second), "kind": "document"},
  ]}}

  files = asyncio.run(_resolve_ctx_ids_to_input_files(
    _DownloadSock(), "chat", ["000123", "000123"], store,
    _history("000123"), "sess-all",
  ))

  assert len(files) == 2
  assert {Path(path).name for path in files} == {
    "first.pdf", "second.csv",
  }
  assert not any(path.endswith(".txt") for path in files)


def test_resolver_fails_closed_with_structured_download_status(tmp_path, monkeypatch):
  monkeypatch.setenv("SUBAGENT_INPUT_STAGING_DIR", str(tmp_path / "staging"))
  store = {"chat": {"000124": [{
    "path": None, "kind": "document", "pending": True,
  }]}}
  sock = _DownloadSock(error=RuntimeError("proto evicted"))

  with pytest.raises(SubAgentInputError) as caught:
    asyncio.run(_resolve_ctx_ids_to_input_files(
      sock, "chat", ["000124"], store, _history("000124"), "sess-fail",
    ))

  assert caught.value.statuses == [{
    "context_msg_id": "000124",
    "state": "download_failed",
    "expected_media": True,
    "paths": [],
    "error": "proto evicted",
  }]
  assert not (tmp_path / "staging" / "sess-fail").exists()


def _receipt(session_id: str, data: bytes) -> dict:
  return {
    "_status_code": 202,
    "accepted": True,
    "status": "processing",
    "session_id": session_id,
    "request_fingerprint": "fingerprint",
    "requested_file_count": 1,
    "staged_file_count": 1,
    "staged_files": [{
      "name": "input.bin",
      "size": len(data),
      "sha256": hashlib.sha256(data).hexdigest(),
    }],
    "file_errors": [],
  }


def test_submit_requires_exact_receiver_checksum_manifest(tmp_path):
  data = b"payload"
  source = tmp_path / "input.bin"
  source.write_bytes(data)
  client = SubAgentClient(base_url="http://sub", webhook_url="http://callback")
  client._post_sync = lambda _url, _payload: _receipt("sess", data)  # type: ignore[method-assign]

  result = asyncio.run(client.submit("sess", "inspect", [str(source)]))
  assert result["accepted"] is True


def test_submit_rejects_partial_staging_even_on_http_202(tmp_path):
  source = tmp_path / "input.bin"
  source.write_bytes(b"payload")
  client = SubAgentClient(base_url="http://sub", webhook_url="http://callback")
  body = _receipt("sess", b"payload")
  body.update({"staged_file_count": 0, "staged_files": []})
  client._post_sync = lambda _url, _payload: body  # type: ignore[method-assign]

  with pytest.raises(SubAgentSubmitError, match="staged only part"):
    asyncio.run(client.submit("sess", "inspect", [str(source)]))


def test_submit_uploads_files_above_inline_cap_before_execute(
  tmp_path, monkeypatch,
):
  import bridge.subagent.client as client_module

  data = b"larger than inline cap"
  source = tmp_path / "large.bin"
  source.write_bytes(data)
  monkeypatch.setattr(client_module, "SUBAGENT_MAX_INLINE_FILE_BYTES", 1)
  captured = {}
  client = SubAgentClient(base_url="http://sub", webhook_url="http://callback")
  expected_sha = hashlib.sha256(data).hexdigest()
  client._upload_file_sync = lambda _path, _identity: {  # type: ignore[method-assign]
    "upload_id": "a" * 32,
    "name": "large.bin",
    "size": len(data),
    "sha256": expected_sha,
  }

  def _post(_url, payload):
    captured.update(payload)
    return _receipt("sess", data)

  client._post_sync = _post  # type: ignore[method-assign]
  asyncio.run(client.submit("sess", "inspect", [str(source)]))
  assert captured["input_files_content"] == []
  assert captured["input_files"] == [{
    "upload_id": "a" * 32,
    "name": "large.bin",
    "size": len(data),
    "sha256": expected_sha,
  }]


def test_client_uses_api_bearer_token_for_post_and_get(monkeypatch):
  import bridge.subagent.client as client_module

  observed: list[tuple[str, dict | None]] = []

  class _Response:
    status_code = 200
    headers: dict = {}
    text = ""

    @staticmethod
    def json():
      return {"ok": True}

  def post(_url, *, json, timeout, headers=None):
    del json, timeout
    observed.append(("post", headers))
    return _Response()

  def get(_url, *, timeout, headers=None):
    del timeout
    observed.append(("get", headers))
    return _Response()

  monkeypatch.setenv("SUBAGENT_API_TOKEN", "main-api-secret")
  monkeypatch.setattr(client_module, "requests", type("Requests", (), {
    "post": staticmethod(post),
    "get": staticmethod(get),
  }))
  client = SubAgentClient(base_url="http://sub", webhook_url="http://callback")

  client._post_sync("http://sub/execute", {"session_id": "x"})
  client._get_sync("http://sub/sessions/x/steering/y")

  assert observed == [
    ("post", {"Authorization": "Bearer main-api-secret"}),
    ("get", {"Authorization": "Bearer main-api-secret"}),
  ]


def test_chunk_upload_is_authenticated_and_checksum_acknowledged(
  tmp_path, monkeypatch,
):
  import bridge.subagent.client as client_module

  data = b"abcdefghij"
  source = tmp_path / "large.bin"
  source.write_bytes(data)
  expected_sha = hashlib.sha256(data).hexdigest()
  calls: list[tuple[str, str, dict]] = []
  identity: dict = {}

  class _Response:
    headers: dict = {}
    text = ""

    def __init__(self, status_code, body):
      self.status_code = status_code
      self._body = body

    def json(self):
      return self._body

  def post(url, *, timeout, headers, json=None):
    del timeout
    calls.append(("post", url, headers))
    if url.endswith("/uploads/init"):
      identity.update(json)
      return _Response(201, {
        "success": True,
        **json,
        "state": "receiving",
        "max_chunk_bytes": 4,
      })
    return _Response(200, {
      "success": True,
      **identity,
      "complete": True,
      "state": "complete",
    })

  def put(url, *, timeout, headers, data):
    del timeout
    calls.append(("put", url, headers))
    index = int(url.rsplit("/", 1)[-1])
    raw_range = headers["Content-Range"].removeprefix("bytes ")
    interval, _total = raw_range.split("/")
    start, end = (int(value) for value in interval.split("-"))
    return _Response(201, {
      "success": True,
      "upload_id": identity["upload_id"],
      "chunk": {
        "index": index,
        "start": start,
        "end": end,
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
      },
    })

  monkeypatch.setenv("SUBAGENT_API_TOKEN", "upload-secret")
  monkeypatch.setattr(client_module, "requests", type("Requests", (), {
    "post": staticmethod(post),
    "put": staticmethod(put),
  }))
  client = SubAgentClient(base_url="http://sub", webhook_url="http://callback")
  result = client._upload_file_sync(str(source), {
    "name": "large.bin",
    "size": len(data),
    "sha256": expected_sha,
  })

  assert result["upload_id"] == identity["upload_id"]
  assert result["sha256"] == expected_sha
  assert [call[0] for call in calls] == ["post", "put", "put", "put", "post"]
  assert all(
    call[2]["Authorization"] == "Bearer upload-secret" for call in calls
  )
