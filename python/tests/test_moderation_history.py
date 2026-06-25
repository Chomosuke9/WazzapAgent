"""Regression tests for the moderation/delete history notes that stop the bot
from spamming mute/kick/delete.

Root cause (before this fix): ``_dispatch_actions`` appended a provisional
assistant history entry for send_message / sticker / quiz (so LLM2 sees its own
action next turn), but kick/delete appended NOTHING and mute only sent a
WhatsApp notification that reached history later via the unreliable fromMe echo.
The offending messages stay in the rolling window, so LLM2 re-issued the
moderation action every burst. These pure helpers build the synthetic history
lines that record the action so the model knows it already acted.
"""
from __future__ import annotations

from collections import deque

from bridge.history import WhatsAppMessage
from bridge.agent.batch_processor import (
  _resolve_ref_name,
  _kick_history_note,
  _delete_history_note,
)


# --- _resolve_ref_name ---

def test_resolve_ref_name_from_history():
  hist = deque([
    WhatsAppMessage(timestamp_ms=0, sender="Alice", sender_ref="u8k2d1", text="hi"),
  ])
  assert _resolve_ref_name(hist, None, "u8k2d1") == "Alice"
  assert _resolve_ref_name(hist, None, "zzzzzz") is None
  assert _resolve_ref_name(hist, None, "") is None


def test_resolve_ref_name_from_current_burst():
  cur = WhatsAppMessage(timestamp_ms=0, sender="Bob", sender_ref="abc123", text="x")
  assert _resolve_ref_name(deque(), cur, "abc123") == "Bob"


# --- _kick_history_note ---

def test_kick_history_note_resolves_names_and_falls_back_to_ref():
  note = _kick_history_note(
    [{"senderRef": "u8k2d1"}, {"senderRef": "abc123"}],
    {"u8k2d1": "Alice"}.get,  # abc123 is unresolved
  )
  assert note is not None
  assert note.startswith("Removed from the group:")
  assert "Alice (u8k2d1)" in note
  assert "abc123" in note  # unresolved senderRef rendered bare


def test_kick_history_note_empty_targets_returns_none():
  assert _kick_history_note([], lambda r: None) is None
  assert _kick_history_note([{"senderRef": ""}], lambda r: None) is None
  assert _kick_history_note([{"not": "a ref"}], lambda r: None) is None


# --- _delete_history_note ---

def test_delete_history_note_valid_and_invalid():
  assert _delete_history_note("000123") == "Deleted message 000123."
  assert _delete_history_note(None) is None
  assert _delete_history_note("garbage") is None   # not a 6-digit context id
  assert _delete_history_note("123") is None       # wrong length
