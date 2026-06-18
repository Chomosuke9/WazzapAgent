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
