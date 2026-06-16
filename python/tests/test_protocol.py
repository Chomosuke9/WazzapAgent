"""Tests for the WaSocket SDK wire protocol (Step 23).

Covers:
  (a) round-trip ``decode(encode(x)) == x`` for one instance of every action
      and every event dataclass;
  (b) golden JSON samples (from gateway.py / CONTRACT.md §1) decode without
      field loss;
  (c) a control event (clear_history) encodes with chatId/folderPath at the
      TOP LEVEL (no 'payload' key);
  (d) camelCase<->snake_case verified on SendMessageAction (reply_to->replyTo).

Import path mirrors the existing suite: ``python`` is placed on
``sys.path`` so the SDK imports as ``wasocket.protocol``.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from wasocket.protocol import (  # noqa: E402
    AckResult,
    ClearHistoryEvent,
    DeleteMessageAction,
    ErrorResult,
    Hello,
    HelloAck,
    InvalidateChatSettingsEvent,
    InvalidateDefaultModelEvent,
    InvalidateLlm2ModelEvent,
    KickMemberAction,
    MarkReadAction,
    ReactMessageAction,
    RelayLottieStickerAction,
    RunCommandAction,
    SendButtonsAction,
    SendCarouselAction,
    SendCopyCodeAction,
    SendMessageAction,
    SendPresenceAction,
    SendQuizAction,
    SetLlm2ModelEvent,
    SetSubagentEnabledEvent,
    WhatsAppStatusEvent,
    camel_to_snake,
    decode,
    encode,
    snake_to_camel,
)

# One representative instance of every frame dataclass defined in CONTRACT.md §6.
ROUND_TRIP_INSTANCES = [
    # handshake
    Hello(folder_path="/tenants/acme"),
    HelloAck(folder_path="/tenants/acme", wa_status="open"),
    # actions
    SendMessageAction(
        request_id="send-1715097600000-000042",
        chat_id="123@g.us",
        text="hi @Name (u8k2d1)",
        reply_to="000124",
        attachments=[{"kind": "image", "path": "data/media/x.jpg", "caption": "c"}],
    ),
    ReactMessageAction(
        request_id="react-1-000001", chat_id="123@g.us", context_msg_id="000125", emoji="👍"
    ),
    DeleteMessageAction(
        request_id="delete-1-000002", chat_id="123@g.us", context_msg_id="000125"
    ),
    KickMemberAction(
        request_id="kick-1-000003",
        chat_id="123@g.us",
        targets=(
            {"senderRef": "u8k2d1"},
            {"senderRef": "u1m9qa"},
        ),
        mode="partial_success",
    ),
    MarkReadAction(chat_id="123@g.us", message_id="wamid-abc", participant="98765@s.whatsapp.net"),
    SendPresenceAction(chat_id="123@g.us", type="composing"),
    SendQuizAction(
        request_id="quiz-1-000004",
        chat_id="123@g.us",
        question="Capital of Indonesia?",
        choices=({"label": "A", "text": "Jakarta"}, {"label": "B", "text": "Bali"}),
        reply_to="000125",
        footer="Choose wisely",
    ),
    SendCopyCodeAction(
        request_id="copy-1-000005",
        chat_id="123@g.us",
        code="PROMO2024",
        display_text="Salin Kode",
        reply_to="000125",
        quoted_preview_text="Your promo code",
    ),
    RelayLottieStickerAction(
        request_id="sticker-1-000006",
        chat_id="123@g.us",
        lottie_payload="{\"a\":1}",
        reply_to="000125",
    ),
    SendButtonsAction(
        request_id="btns-1-000007",
        chat_id="123@g.us",
        text="Choose:",
        buttons=({"name": "quick_reply", "buttonParams": {"display_text": "A", "id": "a"}},),
        footer="Footer",
    ),
    SendCarouselAction(
        request_id="carousel-1-000008",
        chat_id="123@g.us",
        cards=(
            {"body": "Card 1", "buttons": [{"name": "quick_reply"}]},
            {"image": "data/media/c2.jpg", "body": "Card 2", "buttons": []},
        ),
        text="Check these out",
    ),
    RunCommandAction(
        request_id="cmd-1-000009",
        chat_id="123@g.us",
        command="/sticker",
        context_msg_id="000125",
    ),
    # ack / error
    AckResult(
        request_id="delete-1-000002",
        action="delete_message",
        ok=True,
        detail="deleted",
        code=None,
        result={"contextMsgId": "000125", "messageId": "wamid-abc"},
    ),
    ErrorResult(
        message="delete_message failed",
        detail="contextMsgId 000999 not found",
        code="not_found",
        request_id="delete-1-000002",
        action="delete_message",
    ),
    # events
    WhatsAppStatusEvent(
        folder_path="/tenants/acme", status="open", instance_id="gw-1", reason=None
    ),
    ClearHistoryEvent(folder_path="/tenants/acme", chat_id="123@g.us"),
    SetLlm2ModelEvent(folder_path="/tenants/acme", chat_id="global", model_id="gpt-4o"),
    SetLlm2ModelEvent(folder_path="/tenants/acme", chat_id="123@g.us", model_id=None),
    InvalidateLlm2ModelEvent(folder_path="/tenants/acme", chat_id="123@g.us"),
    InvalidateDefaultModelEvent(folder_path="/tenants/acme"),
    InvalidateChatSettingsEvent(folder_path="/tenants/acme", chat_id="global"),
    SetSubagentEnabledEvent(folder_path="/tenants/acme", chat_id="123@g.us", enabled=True),
]


@pytest.mark.parametrize("frame", ROUND_TRIP_INSTANCES, ids=lambda f: type(f).__name__)
def test_round_trip_decode_encode(frame):
    """decode(encode(x)) == x for one instance of every frame dataclass."""
    raw = encode(frame)
    type_str, parsed = decode(raw)
    assert isinstance(raw, str)
    assert isinstance(type_str, str) and type_str
    assert parsed == frame
    assert type(parsed) is type(frame)


# ---------------------------------------------------------------------------
# (b) Golden JSON samples — taken verbatim from gateway.py / CONTRACT.md §1.
# Each must decode into the right dataclass with no field loss.
# ---------------------------------------------------------------------------

GOLDEN_ACTIONS = [
    # send_message — gateway.send_message()
    (
        {
            "type": "send_message",
            "payload": {
                "requestId": "send-1-000001",
                "chatId": "123@g.us",
                "text": "hello",
                "replyTo": "000124",
            },
        },
        SendMessageAction,
        {"request_id": "send-1-000001", "chat_id": "123@g.us", "text": "hello", "reply_to": "000124"},
    ),
    # send_message with attachment — gateway.send_attachment()
    (
        {
            "type": "send_message",
            "payload": {
                "requestId": "send-1-000002",
                "chatId": "123@g.us",
                "attachments": [{"kind": "document", "path": "data/media/f.pdf", "fileName": "f.pdf"}],
                "replyTo": "000124",
            },
        },
        SendMessageAction,
        {"request_id": "send-1-000002", "chat_id": "123@g.us", "reply_to": "000124"},
    ),
    # react_message
    (
        {
            "type": "react_message",
            "payload": {
                "requestId": "react-1-000001",
                "chatId": "123@g.us",
                "contextMsgId": "000125",
                "emoji": "👍",
            },
        },
        ReactMessageAction,
        {"request_id": "react-1-000001", "chat_id": "123@g.us", "context_msg_id": "000125", "emoji": "👍"},
    ),
    # delete_message
    (
        {
            "type": "delete_message",
            "payload": {"requestId": "delete-1-000001", "chatId": "123@g.us", "contextMsgId": "000125"},
        },
        DeleteMessageAction,
        {"request_id": "delete-1-000001", "chat_id": "123@g.us", "context_msg_id": "000125"},
    ),
    # kick_member
    (
        {
            "type": "kick_member",
            "payload": {
                "requestId": "kick-1-000001",
                "chatId": "123@g.us",
                "targets": [{"senderRef": "u8k2d1"}],
                "mode": "partial_success",
            },
        },
        KickMemberAction,
        {"request_id": "kick-1-000001", "chat_id": "123@g.us", "mode": "partial_success"},
    ),
    # mark_read (no requestId)
    (
        {
            "type": "mark_read",
            "payload": {"chatId": "123@g.us", "messageId": "wamid-abc", "participant": "9@s.whatsapp.net"},
        },
        MarkReadAction,
        {"chat_id": "123@g.us", "message_id": "wamid-abc", "participant": "9@s.whatsapp.net"},
    ),
    # send_presence (no requestId)
    (
        {"type": "send_presence", "payload": {"chatId": "123@g.us", "type": "composing"}},
        SendPresenceAction,
        {"chat_id": "123@g.us", "type": "composing"},
    ),
    # send_quiz
    (
        {
            "type": "send_quiz",
            "payload": {
                "requestId": "quiz-1-000001",
                "chatId": "123@g.us",
                "question": "Q?",
                "choices": [{"label": "A", "text": "Jakarta"}],
                "replyTo": "000125",
                "footer": "f",
            },
        },
        SendQuizAction,
        {"request_id": "quiz-1-000001", "chat_id": "123@g.us", "question": "Q?", "reply_to": "000125", "footer": "f"},
    ),
    # send_copy_code
    (
        {
            "type": "send_copy_code",
            "payload": {
                "requestId": "copy-1-000001",
                "chatId": "123@g.us",
                "code": "PROMO2024",
                "displayText": "Copy Code",
                "replyTo": "000125",
                "quotedPreviewText": "preview",
            },
        },
        SendCopyCodeAction,
        {
            "request_id": "copy-1-000001",
            "chat_id": "123@g.us",
            "code": "PROMO2024",
            "display_text": "Copy Code",
            "reply_to": "000125",
            "quoted_preview_text": "preview",
        },
    ),
    # relay_lottie_sticker
    (
        {
            "type": "relay_lottie_sticker",
            "payload": {
                "requestId": "sticker-1-000001",
                "chatId": "123@g.us",
                "lottiePayload": "{}",
                "replyTo": "000125",
            },
        },
        RelayLottieStickerAction,
        {"request_id": "sticker-1-000001", "chat_id": "123@g.us", "lottie_payload": "{}", "reply_to": "000125"},
    ),
    # send_buttons
    (
        {
            "type": "send_buttons",
            "payload": {
                "requestId": "btns-1-000001",
                "chatId": "123@g.us",
                "text": "Choose:",
                "buttons": [{"name": "quick_reply", "buttonParams": {"display_text": "A", "id": "a"}}],
                "footer": "f",
            },
        },
        SendButtonsAction,
        {"request_id": "btns-1-000001", "chat_id": "123@g.us", "text": "Choose:", "footer": "f"},
    ),
    # send_carousel
    (
        {
            "type": "send_carousel",
            "payload": {
                "requestId": "carousel-1-000001",
                "chatId": "123@g.us",
                "cards": [{"body": "Card 1", "buttons": []}],
                "text": "header",
            },
        },
        SendCarouselAction,
        {"request_id": "carousel-1-000001", "chat_id": "123@g.us", "text": "header"},
    ),
    # run_command
    (
        {
            "type": "run_command",
            "payload": {
                "requestId": "cmd-1-000001",
                "chatId": "123@g.us",
                "command": "/sticker",
                "contextMsgId": "000125",
            },
        },
        RunCommandAction,
        {"request_id": "cmd-1-000001", "chat_id": "123@g.us", "command": "/sticker", "context_msg_id": "000125"},
    ),
]


@pytest.mark.parametrize("raw_frame, cls, expected_subset", GOLDEN_ACTIONS, ids=lambda v: v if isinstance(v, str) else None)
def test_golden_action_decodes_without_field_loss(raw_frame, cls, expected_subset):
    type_str, parsed = decode(json.dumps(raw_frame))
    assert type_str == raw_frame["type"]
    assert type(parsed) is cls
    # Every scalar field present in the golden payload is preserved.
    for field, value in expected_subset.items():
        assert getattr(parsed, field) == value


def test_golden_action_preserves_collection_fields():
    """Targets/choices/attachments are not dropped during decode."""
    _, kick = decode(json.dumps(GOLDEN_ACTIONS[4][0]))
    assert kick.targets == ({"senderRef": "u8k2d1"},)

    _, attach_msg = decode(json.dumps(GOLDEN_ACTIONS[1][0]))
    assert attach_msg.attachments == [
        {"kind": "document", "path": "data/media/f.pdf", "fileName": "f.pdf"}
    ]

    _, quiz = decode(json.dumps(GOLDEN_ACTIONS[7][0]))
    assert quiz.choices == ({"label": "A", "text": "Jakarta"},)


GOLDEN_ACKS = [
    (
        {
            "type": "action_ack",
            "payload": {
                "requestId": "delete-1-000001",
                "action": "delete_message",
                "ok": True,
                "detail": "deleted",
                "code": None,
                "result": {"contextMsgId": "000125", "messageId": "wamid-abc"},
            },
        },
        AckResult,
    ),
    (
        {
            "type": "error",
            "payload": {
                "message": "delete_message failed",
                "detail": "contextMsgId 000999 not found",
                "code": "not_found",
                "requestId": "delete-1-000001",
                "action": "delete_message",
            },
        },
        ErrorResult,
    ),
]


@pytest.mark.parametrize("raw_frame, cls", GOLDEN_ACKS)
def test_golden_ack_and_error_decode(raw_frame, cls):
    type_str, parsed = decode(json.dumps(raw_frame))
    assert type_str == raw_frame["type"]
    assert type(parsed) is cls
    for wire_key, value in raw_frame["payload"].items():
        assert getattr(parsed, camel_to_snake(wire_key)) == value


# ---------------------------------------------------------------------------
# (c) Control events serialize with TOP-LEVEL fields (no payload wrapper).
# ---------------------------------------------------------------------------

def test_control_event_encodes_at_top_level_no_payload():
    frame = ClearHistoryEvent(folder_path="/tenants/acme", chat_id="123@g.us")
    raw = encode(frame)
    obj = json.loads(raw)
    assert obj["type"] == "clear_history"
    assert "payload" not in obj
    assert obj["folderPath"] == "/tenants/acme"
    assert obj["chatId"] == "123@g.us"


def test_control_event_with_extra_fields_top_level():
    frame = SetLlm2ModelEvent(folder_path="/tenants/acme", chat_id="global", model_id="gpt-4o")
    obj = json.loads(encode(frame))
    assert "payload" not in obj
    assert obj == {
        "type": "set_llm2_model",
        "folderPath": "/tenants/acme",
        "chatId": "global",
        "modelId": "gpt-4o",
    }


def test_control_event_decodes_from_top_level():
    raw = json.dumps({"type": "clear_history", "folderPath": "/tenants/acme", "chatId": "global"})
    type_str, parsed = decode(raw)
    assert type_str == "clear_history"
    assert parsed == ClearHistoryEvent(folder_path="/tenants/acme", chat_id="global")


def test_action_uses_payload_wrapper():
    frame = DeleteMessageAction(request_id="d-1", chat_id="c", context_msg_id="000125")
    obj = json.loads(encode(frame))
    assert "payload" in obj
    assert obj["payload"]["contextMsgId"] == "000125"
    assert "contextMsgId" not in obj  # not at top level for non-control frames


# ---------------------------------------------------------------------------
# (d) camelCase <-> snake_case mapping (centralized helpers + on a real frame).
# ---------------------------------------------------------------------------

def test_send_message_reply_to_maps_to_reply_to_camel():
    frame = SendMessageAction(request_id="r1", chat_id="c", text="hi", reply_to="000124")
    payload = json.loads(encode(frame))["payload"]
    assert "replyTo" in payload
    assert "reply_to" not in payload
    assert payload["replyTo"] == "000124"
    assert payload["requestId"] == "r1"
    assert payload["chatId"] == "c"


@pytest.mark.parametrize(
    "snake, camel",
    [
        ("folder_path", "folderPath"),
        ("chat_id", "chatId"),
        ("request_id", "requestId"),
        ("reply_to", "replyTo"),
        ("context_msg_id", "contextMsgId"),
        ("duration_minutes", "durationMinutes"),
        ("protocol_version", "protocolVersion"),
        ("wa_status", "waStatus"),
        ("model_id", "modelId"),
        ("quoted_preview_text", "quotedPreviewText"),
    ],
)
def test_case_conversion_round_trips(snake, camel):
    assert snake_to_camel(snake) == camel
    assert camel_to_snake(camel) == snake


def test_decode_unknown_type_returns_raw_dict():
    raw = json.dumps({"type": "send_ack", "payload": {"requestId": "r1"}})
    type_str, parsed = decode(raw)
    assert type_str == "send_ack"
    assert isinstance(parsed, dict)
    assert parsed == {"type": "send_ack", "payload": {"requestId": "r1"}}
