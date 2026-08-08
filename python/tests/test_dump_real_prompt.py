"""Tests for the shared LLM2 message builder that ``/dump`` now serialises.

``/dump`` used to hand-rebuild a *subset* of the LLM2 prompt (system prompt,
group description, chat state, older messages, current message) and therefore
MISSED the sub-agent helper blocks (the ``execute_subtask`` file-ID lookup and
the sub-agent state block) and the real context/helper injection. It now calls
:func:`bridge.llm.llm2.build_llm2_messages` — the same builder
:func:`bridge.llm.llm2.generate_reply` uses — and serialises the result with
:func:`bridge.llm.llm2.serialize_llm2_messages`, so the dump is the REAL prompt
the model sees.

These tests pin that contract:
  1. ``serialize_llm2_messages`` labels roles and redacts inline image base64.
  2. ``build_llm2_messages`` (what the dump serialises) includes the sub-agent
     rules, the sub-agent state block, the ``<files_in_chat>`` ``execute_subtask``
     helper, and the real older-messages + current-burst history.

The DB/IO seams are monkeypatched so the test is hermetic (no tenant DB, no
network, no model vision lookup).
"""
from __future__ import annotations

from langchain_core.messages import HumanMessage, SystemMessage

import bridge.llm.llm2 as llm2_mod
from bridge.history import WhatsAppMessage


def _msg(cid: str, text: str, **kw) -> WhatsAppMessage:
    return WhatsAppMessage(timestamp_ms=0, context_msg_id=cid, text=text, **kw)


def _patch_db(monkeypatch) -> None:
    """Neutralise the DB/IO touchpoints inside build_llm2_messages."""
    monkeypatch.setattr(llm2_mod, "db_get_permission", lambda *a, **k: 0)
    monkeypatch.setattr(llm2_mod, "get_model_vision_support", lambda *a, **k: False)
    monkeypatch.setattr(llm2_mod, "sticker_catalog_text", lambda *a, **k: "")


def test_serialize_llm2_messages_labels_roles_and_redacts_images():
    msgs = [
        SystemMessage(content="SYSTEM-CONTENT"),
        HumanMessage(content="plain user content"),
        HumanMessage(
            content=[
                {"type": "text", "text": "look at this"},
                {
                    "type": "image_url",
                    "image_url": {"url": "data:image/png;base64,SECRETBLOB=="},
                },
            ]
        ),
    ]
    out = llm2_mod.serialize_llm2_messages(msgs)
    assert "=== SYSTEM ===\nSYSTEM-CONTENT" in out
    assert "=== USER ===\nplain user content" in out
    assert "look at this" in out
    # The base64 blob must be redacted, not leaked verbatim, into the dump.
    assert "SECRETBLOB" not in out
    assert "base64-redacted" in out


def test_build_messages_includes_subagent_helper_and_real_history(monkeypatch):
    _patch_db(monkeypatch)
    history = [
        _msg("000100", "first older message", sender="Alice", sender_ref="a1"),
        # A message that actually CARRIES a file -> must appear in <files_in_chat>.
        _msg(
            "000101",
            "report.pdf",
            sender="Bob",
            sender_ref="b2",
            media="document",
        ),
    ]
    current = _msg("000102", "/dump", sender="Alice", sender_ref="a1")

    built = llm2_mod.build_llm2_messages(
        history,
        current,
        current_payload={"chatId": "grp@g.us"},
        group_description="A test group",
        chat_type="group",
        bot_is_admin=True,
        allow_subagent=True,
        subagent_context=(
            "## Active sub-agent task (already running for this chat)\n"
            "Working on it."
        ),
    )
    text = llm2_mod.serialize_llm2_messages(built.messages)

    # --- sub-agent helper content (the whole point of the change) ---
    # 1) sub-agent tool rules injected into the system prompt
    assert "<subagent>" in text
    # 2) the sub-agent state block (active task) injected as its own message
    assert "Active sub-agent task" in text
    # 3) the execute_subtask file-ID helper (<files_in_chat>) listing the file
    assert "<files_in_chat>" in text
    assert "[#000101]" in text
    assert "report.pdf" in text

    # --- real history, exactly as the model sees it ---
    assert "older messages:" in text
    assert "current messages(burst):" in text
    assert "first older message" in text


def test_build_messages_omits_subagent_helper_when_disabled(monkeypatch):
    _patch_db(monkeypatch)
    history = [
        _msg("000101", "report.pdf", sender="Bob", sender_ref="b2", media="document"),
    ]
    current = _msg("000102", "/dump", sender="Alice", sender_ref="a1")

    built = llm2_mod.build_llm2_messages(
        history,
        current,
        current_payload={"chatId": "grp@g.us"},
        chat_type="group",
        allow_subagent=False,
        subagent_context=None,
    )
    text = llm2_mod.serialize_llm2_messages(built.messages)

    # With the sub-agent disabled, neither the file helper nor an active-task
    # block should be present, but the real history still is.
    assert "<files_in_chat>" not in text
    assert "Active sub-agent task" not in text
    assert "report.pdf" in text  # still in older-messages history


def test_llm2_uses_compact_chat_information_without_activity_metadata(monkeypatch):
    _patch_db(monkeypatch)
    current = _msg("000102", "hello", sender="Alice", sender_ref="a1")
    built = llm2_mod.build_llm2_messages(
        [],
        current,
        current_payload={
            "chatId": "grp@g.us",
            "chatName": "Project Room",
            "llm1Reason": "mentioned",
            "messagesSinceAssistantReply": 12,
            "humanMessagesInWindow": 3,
        },
        group_description="Build discussion",
        chat_type="group",
        bot_is_admin=True,
    )
    text = llm2_mod.serialize_llm2_messages(built.messages)
    assert "Chat information:" in text
    assert "Group name: Project Room" in text
    assert "Group description: Build discussion" in text
    assert "Chat state: group" in text
    assert "Bot role: admin" in text
    assert "Bot moderation permission: 0" in text
    assert "Bot moderation capabilities: none" in text
    assert "Current message metadata:" not in text
    assert "Invoke reason:" not in text
    assert "Currently muted users" not in text


def test_chat_information_shows_effective_permission_capabilities(monkeypatch):
    _patch_db(monkeypatch)
    monkeypatch.setattr(llm2_mod, "db_get_permission", lambda *_a, **_k: 2)
    current = _msg("000103", "hello", sender="Alice", sender_ref="a1")
    built = llm2_mod.build_llm2_messages(
        [],
        current,
        current_payload={"chatId": "grp@g.us", "chatName": "Project Room"},
        chat_type="group",
        bot_is_admin=True,
    )
    text = llm2_mod.serialize_llm2_messages(built.messages)
    assert "Bot moderation permission: 2" in text
    assert "Bot moderation capabilities: delete messages, mute members" in text


def test_non_admin_chat_information_forces_effective_permission_zero(monkeypatch):
    _patch_db(monkeypatch)
    monkeypatch.setattr(llm2_mod, "db_get_permission", lambda *_a, **_k: 3)
    current = _msg("000104", "hello", sender="Alice", sender_ref="a1")
    built = llm2_mod.build_llm2_messages(
        [],
        current,
        current_payload={"chatId": "grp@g.us", "chatName": "Project Room"},
        group_description="Build discussion",
        chat_type="group",
        bot_is_admin=False,
    )
    text = llm2_mod.serialize_llm2_messages(built.messages)
    assert "Bot moderation permission: 0" in text
    assert "Bot moderation capabilities: none (bot is not a group admin)" in text
