"""Tests for the subagent_enabled cache invalidation helper.

The bridge caches per-chat subagent_enabled state in-process so it doesn't
hit SQLite on every burst. The helper exercised here is what the WS
``set_subagent_enabled`` handler calls so /subagent on takes effect
without restarting the bridge.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Make ``bridge.db`` importable without going through the full package init.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import bridge.db as db  # noqa: E402


def test_clear_subagent_enabled_cache_specific_chat():
    db._subagent_enabled_cache.clear()
    db._subagent_enabled_cache["chat-a"] = True
    db._subagent_enabled_cache["chat-b"] = False

    db.clear_subagent_enabled_cache("chat-a")

    assert "chat-a" not in db._subagent_enabled_cache
    assert db._subagent_enabled_cache.get("chat-b") is False


def test_clear_subagent_enabled_cache_all():
    db._subagent_enabled_cache.clear()
    db._subagent_enabled_cache["chat-a"] = True
    db._subagent_enabled_cache["chat-b"] = False

    db.clear_subagent_enabled_cache(None)

    assert db._subagent_enabled_cache == {}


def test_clear_subagent_enabled_cache_missing_chat_is_noop():
    # Should not raise if the chat_id isn't cached yet — happens on the
    # very first /subagent on call before any get_subagent_enabled lookup.
    db._subagent_enabled_cache.clear()
    db._subagent_enabled_cache["chat-a"] = True

    db.clear_subagent_enabled_cache("chat-never-cached")

    assert db._subagent_enabled_cache.get("chat-a") is True
