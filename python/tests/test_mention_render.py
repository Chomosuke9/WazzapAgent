"""Live mention re-rendering — Python side (the reported bug fix).

A ``/memory`` entry persists mentions as ``@<name> (<senderRef>)`` where the
name was BAKED at save time. A person who hadn't spoken yet was frozen as their
bare LID number (e.g. ``@41314028625930 (8wopaq)``) — and the old code injected
that verbatim into the prompt, so the LLM saw the number forever.

``render_stored_mentions`` fixes this by swapping the baked name for the
participant's CURRENT name, looked up by senderRef in the ``participant_names``
roster the Node gateway keeps fresh on every inbound message. The senderRef (the
stable anchor the model reuses to tag someone) is preserved; a miss leaves the
token exactly as stored.
"""
from __future__ import annotations

import bridge.llm.prompt as prompt_mod
from bridge.db import get_participant_name, tenant_db_context
from bridge.db.core import _get_settings_conn


def _set_name(chat_id: str, sender_ref: str, name: str) -> None:
    """Mirror Node's SettingsRepository.upsertParticipantName."""
    conn = _get_settings_conn()
    conn.execute(
        """INSERT INTO participant_names (chat_id, sender_ref, name)
           VALUES (?, ?, ?)
           ON CONFLICT(chat_id, sender_ref) DO UPDATE SET name = excluded.name""",
        (chat_id, sender_ref, name),
    )
    conn.commit()


def _add_memory(scope_key: str, text: str) -> None:
    conn = _get_settings_conn()
    conn.execute(
        "INSERT INTO memories (scope_key, text) VALUES (?, ?)", (scope_key, text)
    )
    conn.commit()


def test_render_swaps_baked_number_for_live_name(tmp_path):
    chat = "c@g.us"
    with tenant_db_context(str(tmp_path)):
        # Saved when this person hadn't spoken -> name baked as the LID number.
        _set_name(chat, "8wopaq", "Andi")
        text = "@41314028625930 (8wopaq) adalah developer saya."
        assert prompt_mod.render_stored_mentions(text, chat) == (
            "@Andi (8wopaq) adalah developer saya."
        )


def test_render_reflects_rename(tmp_path):
    chat = "c@g.us"
    with tenant_db_context(str(tmp_path)):
        _set_name(chat, "8wopaq", "Andi")
        assert prompt_mod.render_stored_mentions("@Andi (8wopaq)", chat) == "@Andi (8wopaq)"
        # Display-name change -> roster updates -> render tracks it (no cache).
        _set_name(chat, "8wopaq", "Andi Wijaya")
        assert (
            prompt_mod.render_stored_mentions("@Andi (8wopaq)", chat)
            == "@Andi Wijaya (8wopaq)"
        )


def test_render_miss_leaves_token_untouched(tmp_path):
    chat = "c@g.us"
    with tenant_db_context(str(tmp_path)):
        # No roster row for this senderRef -> keep EXACTLY as stored.
        text = "@212678274510860 (2lkl63) adalah admin."
        assert prompt_mod.render_stored_mentions(text, chat) == text


def test_render_multiple_mentions_and_reserved_all(tmp_path):
    chat = "c@g.us"
    with tenant_db_context(str(tmp_path)):
        _set_name(chat, "1berov", "Budi")
        _set_name(chat, "8wopaq", "Andi")
        text = "@whoami (1berov) dan @41314028625930 (8wopaq) — tag @all (all)"
        # Both known refs are swapped; `@all (all)` is left alone because "all"
        # is not a 6-char senderRef so it can never match the mention grammar.
        assert prompt_mod.render_stored_mentions(text, chat) == (
            "@Budi (1berov) dan @Andi (8wopaq) — tag @all (all)"
        )


def test_build_memory_block_renders_live_names(tmp_path):
    chat = "c@g.us"
    with tenant_db_context(str(tmp_path)):
        _set_name(chat, "8wopaq", "Andi")
        _add_memory(chat, "@41314028625930 (8wopaq) adalah developer saya.")
        block = prompt_mod.build_memory_block(chat)
        assert block is not None
        assert "@Andi (8wopaq) adalah developer saya." in block
        # The bare LID number must NOT reach the LLM-facing block anymore.
        assert "41314028625930" not in block


def test_get_participant_name_roundtrip_and_misses(tmp_path):
    chat = "c@g.us"
    with tenant_db_context(str(tmp_path)):
        _set_name(chat, "abc123", "Citra")
        assert get_participant_name(chat, "abc123") == "Citra"
        assert get_participant_name(chat, "nope12") is None  # unknown ref
        assert get_participant_name("", "abc123") is None  # guard
