"""Unit tests for the ``bridge.media.resolver`` helpers (Step 08).

Exercises the relocated media/sticker resolution helpers directly against a
caller-supplied ``media_paths_by_chat`` dict + real temp files (``tmp_path``).
No socket / LLM / DB. Mirrors the former module-level helpers in ``session.py``.
"""
from __future__ import annotations

import time
from collections import deque

from bridge.media import (
  _append_sticker_log_to_history,
  _cleanup_stale_media_paths,
  _guess_mime_from_path,
  _parse_sticker_args,
  _resolve_quoted_media_attachments,
  _resolve_sticker_media,
  _store_media_path,
)


# --- _parse_sticker_args ---

def test_parse_sticker_args_upper_and_lower():
  assert _parse_sticker_args("top # bottom") == ("top", "bottom")


def test_parse_sticker_args_upper_only():
  assert _parse_sticker_args("just top") == ("just top", None)


def test_parse_sticker_args_empty():
  assert _parse_sticker_args("   ") == (None, None)


# --- _store_media_path ---

def test_store_media_path_records_attachments():
  store: dict = {}
  payload = {
    "chatId": "c@g.us",
    "contextMsgId": "000125",
    "attachments": [{"kind": "Image", "mime": "image/jpeg", "path": "/tmp/x.jpg"}],
  }
  _store_media_path(store, payload)
  entries = store["c@g.us"]["000125"]
  assert len(entries) == 1
  assert entries[0]["path"] == "/tmp/x.jpg"
  assert entries[0]["kind"] == "image"  # lower-cased
  assert "received_at" in entries[0]


def test_store_media_path_noop_without_ids_or_paths():
  store: dict = {}
  _store_media_path(store, {"attachments": [{"kind": "image", "path": "/tmp/x"}]})  # no ids
  _store_media_path(store, {"chatId": "c", "contextMsgId": "1", "attachments": [{"kind": "image"}]})  # no path
  assert store == {}


def test_store_media_path_groups_by_attachment_ctx_id():
  """After a burst merge, a single payload can carry attachments from several
  messages (each stamped with its own contextMsgId). They must be filed under
  their OWN owning message, not the payload's top-level id — else quoted-image
  reuse / sub-agent resolution looks under the wrong key."""
  store: dict = {}
  payload = {
    "chatId": "c@g.us",
    "contextMsgId": "000090",  # payload top-level (last burst message)
    "attachments": [
      {"kind": "image", "path": "/tmp/a.jpg", "contextMsgId": "000085"},  # own id
      {"kind": "image", "path": "/tmp/b.jpg"},  # no own id -> falls back to payload
    ],
  }
  _store_media_path(store, payload)
  assert store["c@g.us"]["000085"][0]["path"] == "/tmp/a.jpg"
  assert store["c@g.us"]["000090"][0]["path"] == "/tmp/b.jpg"


# --- _merge_payload_attachments (burst attachment union + source stamping) ---

def test_merge_stamps_source_ids_on_attachments():
  """Each attachment is stamped with its SOURCE message's ids so the merged
  payload (whose top-level id is only the last burst message) can still
  download each attachment against the message that actually holds it."""
  from bridge.messaging.moderation import _merge_payload_attachments

  img_payload = {
    "contextMsgId": "000085", "messageId": "wamid-img",
    "attachments": [{"kind": "image", "path": None}],
  }
  text_payload = {"contextMsgId": "000086", "messageId": "wamid-txt", "attachments": []}
  merged = _merge_payload_attachments([img_payload, text_payload], text_payload)

  assert merged["contextMsgId"] == "000086"  # base stays the last message
  assert len(merged["attachments"]) == 1
  assert merged["attachments"][0]["contextMsgId"] == "000085"
  assert merged["attachments"][0]["messageId"] == "wamid-img"
  # the SOURCE payload's own attachment dict must not be mutated
  assert "contextMsgId" not in img_payload["attachments"][0]


def test_merge_does_not_override_existing_attachment_ids():
  from bridge.messaging.moderation import _merge_payload_attachments

  p = {
    "contextMsgId": "000001", "messageId": "m1",
    "attachments": [{"kind": "image", "path": None, "contextMsgId": "000099", "messageId": "m99"}],
  }
  merged = _merge_payload_attachments([p], p)
  assert merged["attachments"][0]["contextMsgId"] == "000099"
  assert merged["attachments"][0]["messageId"] == "m99"


# --- _cleanup_stale_media_paths ---

def test_cleanup_removes_only_stale_entries():
  now = time.time()
  store = {
    "c@g.us": {
      "000001": [{"path": "/a", "received_at": now - 100_000}],  # stale
      "000002": [{"path": "/b", "received_at": now}],            # fresh
    }
  }
  removed = _cleanup_stale_media_paths(store, max_age_seconds=86_400.0)
  assert removed == 1
  assert "000001" not in store["c@g.us"]
  assert "000002" in store["c@g.us"]


def test_cleanup_drops_empty_chat_buckets():
  now = time.time()
  store = {"c": {"1": [{"path": "/a", "received_at": now - 100_000}]}}
  _cleanup_stale_media_paths(store, max_age_seconds=86_400.0)
  assert "c" not in store


# --- _guess_mime_from_path ---

def test_guess_mime_webp():
  assert _guess_mime_from_path("/x/y.webp") == "image/webp"


def test_guess_mime_jpeg_default():
  assert _guess_mime_from_path("/x/y.unknownext") == "image/jpeg"


def test_guess_mime_png():
  assert _guess_mime_from_path("/x/y.png") == "image/png"


# --- _resolve_sticker_media ---

def test_resolve_sticker_media_from_current_attachment(tmp_path):
  f = tmp_path / "img.jpg"
  f.write_bytes(b"data")
  payload = {"attachments": [{"path": str(f)}]}
  assert _resolve_sticker_media({}, payload, "c") == str(f)


def test_resolve_sticker_media_from_quoted_stored(tmp_path):
  f = tmp_path / "img.jpg"
  f.write_bytes(b"data")
  store = {"c": {"000010": [{"path": str(f)}]}}
  payload = {"attachments": [], "quoted": {"contextMsgId": "000010"}}
  assert _resolve_sticker_media(store, payload, "c") == str(f)


def test_resolve_sticker_media_none_when_missing():
  payload = {"attachments": [], "quoted": {"contextMsgId": "000010"}}
  assert _resolve_sticker_media({}, payload, "c") is None


# --- _resolve_quoted_media_attachments ---

def test_resolve_quoted_returns_current_when_already_visual():
  atts = [{"kind": "image", "path": "/tmp/x.jpg"}]
  payload = {"attachments": atts}
  result = _resolve_quoted_media_attachments({}, payload, "c")
  assert result == atts


def test_resolve_quoted_appends_stored_media(tmp_path):
  f = tmp_path / "img.jpg"
  f.write_bytes(b"data")
  store = {"c": {"000010": [{"kind": "image", "path": str(f)}]}}
  payload = {"attachments": [], "quoted": {"contextMsgId": "000010"}}
  result = _resolve_quoted_media_attachments(store, payload, "c")
  assert len(result) == 1
  assert result[0]["path"] == str(f)
  assert result[0]["mime"]  # filled in by _guess_mime_from_path


def test_resolve_quoted_no_quoted_returns_current():
  payload = {"attachments": []}
  assert _resolve_quoted_media_attachments({}, payload, "c") == []


# --- _append_sticker_log_to_history ---

def test_append_sticker_log_to_history_appends_assistant_entry():
  hist: deque = deque()
  _append_sticker_log_to_history(hist, "created sticker")
  assert len(hist) == 1
  assert hist[0].role == "assistant"
  assert hist[0].text == "created sticker"
