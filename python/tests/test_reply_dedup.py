"""Unit tests for :class:`bridge.agent.reply_dedup.ReplyDedup` (Step 08).

Constructs the collaborator directly with fakes (an injected ``reply_signature``
and a controllable ``now_ms`` clock) — no socket / LLM / DB. Mirrors the exact
behaviour of the former ``_is_duplicate_reply`` closure in ``session.py``.
"""
from __future__ import annotations

from bridge.agent.reply_dedup import ReplyDedup


def _norm(text):
  # Stand-in for messaging.processing._reply_signature: deterministic + simple.
  return (text or "").strip().lower()


def _make(window_ms=120_000, min_chars=5, clock=None):
  return ReplyDedup(
    window_ms=window_ms,
    min_chars=min_chars,
    reply_signature=_norm,
    now_ms=clock,
  )


def test_disabled_when_window_non_positive():
  d = _make(window_ms=0)
  assert d.is_duplicate("c", "a long enough message") is False
  # Disabled means nothing is ever recorded either.
  assert d.is_duplicate("c", "a long enough message") is False
  assert len(d.signatures_by_chat["c"]) == 0


def test_short_signature_below_min_chars_is_never_duplicate():
  d = _make(min_chars=10)
  assert d.is_duplicate("c", "short") is False
  # Short replies are not recorded, so a repeat is still not a duplicate.
  assert d.is_duplicate("c", "short") is False
  assert len(d.signatures_by_chat["c"]) == 0


def test_first_seen_not_duplicate_then_recorded():
  d = _make()
  assert d.is_duplicate("c", "hello world reply") is False
  assert len(d.signatures_by_chat["c"]) == 1


def test_exact_repeat_within_window_is_duplicate():
  d = _make()
  assert d.is_duplicate("c", "hello world reply") is False
  assert d.is_duplicate("c", "hello world reply") is True


def test_expired_signature_outside_window_not_duplicate():
  now = {"t": 1_000_000}
  d = _make(window_ms=10_000, clock=lambda: now["t"])
  assert d.is_duplicate("c", "hello world reply") is False
  # Advance the clock beyond the window: old signature is pruned.
  now["t"] += 10_001
  assert d.is_duplicate("c", "hello world reply") is False


def test_per_chat_isolation():
  d = _make()
  assert d.is_duplicate("chat-a", "hello world reply") is False
  # Same text in a different chat is not a duplicate.
  assert d.is_duplicate("chat-b", "hello world reply") is False
  assert "chat-a" in d.signatures_by_chat
  assert "chat-b" in d.signatures_by_chat


def test_max_entries_cap_evicts_oldest():
  d = ReplyDedup(
    window_ms=10_000_000,
    min_chars=1,
    reply_signature=_norm,
    max_entries=3,
  )
  for i in range(10):
    d.is_duplicate("c", f"message-number-{i}")
  assert len(d.signatures_by_chat["c"]) == 3
