"""Long-term memory (the /memory command) — Python-side tests.

Covers the three Python touchpoints:
  1. ``get_memories`` — combines the shared ``__global__`` list (first) with the
     per-chat list (after), each oldest-first; cached + cleared by
     ``reset_settings_connection`` (the invalidate_chat_settings effect).
  2. ``build_memory_block`` — renders the standing ``<long_term_memory>`` block,
     or ``None`` when empty.
  3. ``build_llm2_messages`` — injects the memory block as a HumanMessage in
     BOTH the primary and the text-only fallback message lists.

DB tests use a real per-tenant settings.db under a temp dir via
``tenant_db_context`` (mirrors test_scheduled_task.py); the memory rows are
written directly with the shared connection since the writer lives on the Node
side. The llm2 test monkeypatches the DB/IO seams so it stays hermetic.
"""
from __future__ import annotations

from langchain_core.messages import HumanMessage, SystemMessage

import bridge.db as db
import bridge.llm.llm2 as llm2_mod
import bridge.llm.prompt as prompt_mod
from bridge.db import tenant_db_context, get_memories
from bridge.db.core import (
    GLOBAL_CHAT_ID,
    _get_settings_conn,
    reset_settings_connection,
)
from bridge.history import WhatsAppMessage


def _insert(scope_key: str, text: str) -> None:
    conn = _get_settings_conn()
    conn.execute(
        "INSERT INTO memories (scope_key, text) VALUES (?, ?)", (scope_key, text)
    )
    conn.commit()


# --------------------------------------------------------------------------- #
# get_memories
# --------------------------------------------------------------------------- #

def test_get_memories_combines_global_then_chat_oldest_first(tmp_path):
    with tenant_db_context(str(tmp_path)):
        _insert(GLOBAL_CHAT_ID, "global-1")
        _insert("c@g.us", "chat-1")
        _insert("c@g.us", "chat-2")
        _insert(GLOBAL_CHAT_ID, "global-2")
        # global entries first (in insert order), then chat entries (in order).
        assert get_memories("c@g.us") == ["global-1", "global-2", "chat-1", "chat-2"]


def test_get_memories_empty_is_empty_list(tmp_path):
    with tenant_db_context(str(tmp_path)):
        assert get_memories("nobody@g.us") == []
    assert get_memories("") == []


def test_get_memories_other_chat_isolated_but_sees_global(tmp_path):
    with tenant_db_context(str(tmp_path)):
        _insert("a@g.us", "a-only")
        _insert(GLOBAL_CHAT_ID, "shared")
        assert get_memories("a@g.us") == ["shared", "a-only"]
        # A different chat sees the global entry but NOT a@g.us's private one.
        assert get_memories("b@g.us") == ["shared"]


def test_get_memories_cache_then_invalidation(tmp_path):
    with tenant_db_context(str(tmp_path)):
        _insert("c@g.us", "first")
        assert get_memories("c@g.us") == ["first"]  # populates the cache
        # Insert a second row directly; the cached read still returns the old list.
        _insert("c@g.us", "second")
        assert get_memories("c@g.us") == ["first"]
        # invalidate_chat_settings clears the memory cache via this reset.
        reset_settings_connection()
        assert get_memories("c@g.us") == ["first", "second"]


# --------------------------------------------------------------------------- #
# build_memory_block
# --------------------------------------------------------------------------- #

def test_build_memory_block_none_when_empty(monkeypatch):
    monkeypatch.setattr(db, "get_memories", lambda chat_id: [])
    assert prompt_mod.build_memory_block("c@g.us") is None
    assert prompt_mod.build_memory_block(None) is None


def test_build_memory_block_formats_entries(monkeypatch):
    monkeypatch.setattr(
        db, "get_memories", lambda chat_id: ["Budi likes apple", "Reply in Indonesian"]
    )
    block = prompt_mod.build_memory_block("c@g.us")
    assert block is not None
    assert "<long_term_memory>" in block
    assert "</long_term_memory>" in block
    assert "- Budi likes apple" in block
    assert "- Reply in Indonesian" in block


# --------------------------------------------------------------------------- #
# build_llm2_messages injection (primary + text-only fallback)
# --------------------------------------------------------------------------- #

def _patch_llm2_db(monkeypatch) -> None:
    monkeypatch.setattr(llm2_mod, "db_get_permission", lambda *a, **k: 0)
    monkeypatch.setattr(llm2_mod, "get_model_vision_support", lambda *a, **k: False)
    monkeypatch.setattr(llm2_mod, "sticker_catalog_text", lambda *a, **k: "")


def _human_texts(built) -> list[str]:
    # The memory block is injected as a HumanMessage; the system prompt (a
    # SystemMessage) *mentions* the <long_term_memory> tag by name, so tests
    # must inspect HumanMessages only to avoid a false match on the prompt text.
    return [str(m.content) for m in built.messages if isinstance(m, HumanMessage)]


def test_memory_block_injected_as_humanmessage(monkeypatch):
    _patch_llm2_db(monkeypatch)
    current = WhatsAppMessage(
        timestamp_ms=0, context_msg_id="000100", text="hi", sender="A", sender_ref="a1"
    )
    block = "<long_term_memory>\n- Budi likes apple\n</long_term_memory>"
    built = llm2_mod.build_llm2_messages(
        [],
        current,
        current_payload={"chatId": "g@g.us"},
        chat_type="group",
        memory_block=block,
    )
    # Injected verbatim as a HumanMessage in the primary list (unique content).
    assert any("Budi likes apple" in t for t in _human_texts(built))
    # ...and in the text-only fallback list used on multimodal failure.
    fb_texts = [
        str(m.content) for m in built.text_fallback_messages if isinstance(m, HumanMessage)
    ]
    assert any("Budi likes apple" in t for t in fb_texts)


def test_no_memory_block_means_no_block(monkeypatch):
    _patch_llm2_db(monkeypatch)
    current = WhatsAppMessage(
        timestamp_ms=0, context_msg_id="000100", text="hi", sender="A", sender_ref="a1"
    )
    built = llm2_mod.build_llm2_messages(
        [], current, current_payload={"chatId": "g@g.us"}, chat_type="group"
    )
    # No HumanMessage carries a memory block when none was provided. (The SYSTEM
    # prompt may mention the tag name, so we inspect HumanMessages only.)
    assert not any("<long_term_memory>" in t for t in _human_texts(built))
