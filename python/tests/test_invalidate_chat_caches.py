"""Tests for the per-chat cache-invalidation helper.

Whenever Node writes a setting (mode, prompt, permission, triggers, LLM2
model, subagent_enabled) it now sends an ``invalidate_chat_settings``
event over the WS bridge. The handler calls
:func:`bridge.db.invalidate_chat_caches`, which is what these tests
exercise. Without this hook, the Python bridge would keep serving stale
cached values — that's the user-visible "settings change doesn't take
effect until restart" bug.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import bridge.db as db  # noqa: E402


def _seed_caches(chat_id: str) -> None:
    """Populate every per-chat cache so we can assert it's been popped."""
    db._prompt_cache[chat_id] = "stale-prompt"
    db._permission_cache[chat_id] = 2
    db._mode_cache[chat_id] = "auto"
    db._triggers_cache[chat_id] = "tag,reply"
    db._llm2_model_cache[chat_id] = "stale-model"
    db._subagent_enabled_cache[chat_id] = True


def _clear_all_caches() -> None:
    db._prompt_cache.clear()
    db._permission_cache.clear()
    db._mode_cache.clear()
    db._triggers_cache.clear()
    db._llm2_model_cache.clear()
    db._subagent_enabled_cache.clear()


def test_invalidate_chat_caches_pops_every_per_chat_cache():
    _clear_all_caches()
    _seed_caches("chat-a")
    _seed_caches("chat-b")

    db.invalidate_chat_caches("chat-a")

    # chat-a must be wiped out of every settings-backed cache.
    assert "chat-a" not in db._prompt_cache
    assert "chat-a" not in db._permission_cache
    assert "chat-a" not in db._mode_cache
    assert "chat-a" not in db._triggers_cache
    # _llm2_model_cache and _subagent_enabled_cache are cleared globally
    # by reset_settings_connection() — verified separately below.

    # Other chats' caches are also dropped: invalidate_chat_caches() calls
    # reset_settings_connection(), which by design clears EVERY settings.db-
    # backed cache wholesale (so a forced re-read never serves a stale value).
    # The other chats simply re-read from the fresh DB on next access.
    assert db._prompt_cache.get("chat-b") is None
    assert db._permission_cache.get("chat-b") is None
    assert db._mode_cache.get("chat-b") is None
    assert db._triggers_cache.get("chat-b") is None


def test_invalidate_chat_caches_resets_settings_connection_caches():
    """The helper also resets the SQLite settings connection, which
    wipes _llm2_model_cache and _subagent_enabled_cache process-wide."""
    _clear_all_caches()
    _seed_caches("chat-a")
    _seed_caches("chat-b")

    db.invalidate_chat_caches("chat-a")

    assert db._llm2_model_cache == {}
    assert db._subagent_enabled_cache == {}


def test_invalidate_chat_caches_handles_uncached_chat():
    """Calling with a chat_id that has no entries must not raise."""
    _clear_all_caches()

    db.invalidate_chat_caches("chat-never-seen")

    assert db._prompt_cache == {}
    assert db._permission_cache == {}
    assert db._mode_cache == {}
    assert db._triggers_cache == {}


def test_invalidate_chat_caches_ignores_empty_chat_id():
    """Empty / falsy chat_id must short-circuit instead of corrupting
    the global cache state."""
    _clear_all_caches()
    _seed_caches("chat-a")

    db.invalidate_chat_caches("")

    # All caches for chat-a must remain.
    assert db._prompt_cache.get("chat-a") == "stale-prompt"
    assert db._permission_cache.get("chat-a") == 2
    assert db._mode_cache.get("chat-a") == "auto"
    assert db._triggers_cache.get("chat-a") == "tag,reply"
    assert db._llm2_model_cache.get("chat-a") == "stale-model"
    assert db._subagent_enabled_cache.get("chat-a") is True
