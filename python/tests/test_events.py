# tests/test_events.py
#
# Step 24 — wasocket.events: event-name constants + the SDK's WhatsAppMessage
# (incoming_message) model. Verifies CONTRACT.md §7 parsing behavior.

import pytest

from wasocket import events
from wasocket.events import WhatsAppMessage


# A FULL incoming_message payload (README / CONTRACT §7) with every field
# populated: quoted, attachments, mentionedParticipants, location, etc.
FULL_PAYLOAD = {
    "folderPath": "tenant-a",
    "contextMsgId": "000125",
    "messageId": "wamid-abc",
    "instanceId": "dev-gateway-1",
    "chatId": "12345@g.us",
    "chatName": "Group Name",
    "chatType": "group",
    "senderId": "98765@s.whatsapp.net",
    "senderRef": "u8k2d1",
    "senderName": "Alice",
    "senderIsAdmin": False,
    "senderIsSuperAdmin": False,
    "senderIsOwner": False,
    "isGroup": True,
    "botIsAdmin": True,
    "botIsSuperAdmin": False,
    "fromMe": False,
    "contextOnly": False,
    "triggerLlm1": False,
    "timestampMs": 1738560000000,
    "messageType": "extendedTextMessage",
    "text": "Hello world",
    "quoted": {
        "messageId": "wamid-quoted",
        "contextMsgId": "000124",
        "senderId": "555@s.whatsapp.net",
        "text": "Previous message",
        "type": "conversation",
    },
    "attachments": [
        {
            "kind": "image",
            "mime": "image/jpeg",
            "fileName": "wamid_image.jpg",
            "originalFileName": "photo.jpg",
            "size": 12345,
            "path": "data/media/wamid_image.jpg",
            "isAnimated": False,
            "jpegThumbnail": "base64-encoded-thumbnail...",
        }
    ],
    "mentionedJids": ["123@s.whatsapp.net"],
    "mentionedParticipants": [
        {
            "jid": "123@s.whatsapp.net",
            "senderRef": "u1m9qa",
            "name": "Bob",
            "isBot": False,
        }
    ],
    "botMentioned": False,
    "repliedToBot": False,
    "location": {"degreesLatitude": -6.2, "degreesLongitude": 106.8},
    "groupDescription": "Rules and context for this group",
    "slashCommand": {"command": "/info", "args": ""},
    "commandHandled": False,
    "groupEvent": {"action": "add", "participants": ["1@s.whatsapp.net"], "source": "stub"},
    "actionLog": {"action": "delete_message", "result": "ok"},
}


# A MINIMAL payload: only the "Always" fields from CONTRACT §7. Note that
# `attachments` is Always (may be []) so it is included.
MINIMAL_PAYLOAD = {
    "folderPath": "tenant-a",
    "instanceId": "dev-gateway-1",
    "chatId": "999@s.whatsapp.net",
    "chatName": "Bob",
    "chatType": "private",
    "messageId": "wamid-min",
    "senderId": "999@s.whatsapp.net",
    "senderRef": "z0z0z0",
    "senderName": "Bob",
    "senderIsAdmin": False,
    "senderIsSuperAdmin": False,
    "isGroup": False,
    "botIsAdmin": False,
    "botIsSuperAdmin": False,
    "fromMe": False,
    "contextOnly": False,
    "triggerLlm1": False,
    "timestampMs": 1738560000000,
    "messageType": "conversation",
    "attachments": [],
}


def test_event_name_constants():
    assert events.MESSAGE == "message"
    assert events.STATUS == "status"
    assert events.READY == "ready"
    assert events.ERROR == "error"
    assert events.ACTION_ACK == "action_ack"
    assert events.SEND_ACK == "send_ack"
    assert events.CLEAR_HISTORY == "clear_history"
    assert events.SET_LLM2_MODEL == "set_llm2_model"
    assert events.INVALIDATE_LLM2_MODEL == "invalidate_llm2_model"
    assert events.INVALIDATE_DEFAULT_MODEL == "invalidate_default_model"
    assert events.INVALIDATE_CHAT_SETTINGS == "invalidate_chat_settings"
    assert events.SET_SUBAGENT_ENABLED == "set_subagent_enabled"


def test_full_payload_every_field_populated():
    msg = WhatsAppMessage.from_payload(FULL_PAYLOAD)

    # Always fields (camelCase -> snake_case)
    assert msg.folder_path == "tenant-a"
    assert msg.instance_id == "dev-gateway-1"
    assert msg.chat_id == "12345@g.us"
    assert msg.chat_name == "Group Name"
    assert msg.chat_type == "group"
    assert msg.message_id == "wamid-abc"
    assert msg.sender_id == "98765@s.whatsapp.net"
    assert msg.sender_ref == "u8k2d1"
    assert msg.sender_name == "Alice"
    assert msg.sender_is_admin is False
    assert msg.sender_is_super_admin is False
    assert msg.is_group is True
    assert msg.bot_is_admin is True
    assert msg.bot_is_super_admin is False
    assert msg.from_me is False
    assert msg.context_only is False
    assert msg.trigger_llm1 is False
    assert msg.timestamp_ms == 1738560000000
    assert msg.message_type == "extendedTextMessage"
    assert isinstance(msg.attachments, list) and len(msg.attachments) == 1

    # Optional fields — all populated in the full payload
    assert msg.context_msg_id == "000125"
    assert msg.sender_is_owner is False
    assert msg.text == "Hello world"
    assert msg.quoted["contextMsgId"] == "000124"
    assert msg.mentioned_jids == ["123@s.whatsapp.net"]
    assert msg.mentioned_participants[0]["senderRef"] == "u1m9qa"
    assert msg.bot_mentioned is False
    assert msg.replied_to_bot is False
    assert msg.location["degreesLatitude"] == -6.2
    assert msg.group_description == "Rules and context for this group"
    assert msg.slash_command == {"command": "/info", "args": ""}
    assert msg.command_handled is False
    assert msg.group_event["action"] == "add"
    assert msg.action_log["action"] == "delete_message"

    # folder_path explicitly set (always present per §7)
    assert msg.folder_path is not None


def test_minimal_payload_optionals_are_none():
    msg = WhatsAppMessage.from_payload(MINIMAL_PAYLOAD)

    # required fields present
    assert msg.folder_path == "tenant-a"
    assert msg.chat_type == "private"
    assert msg.attachments == []

    # every optional field is None when absent — and from_payload did not raise
    assert msg.context_msg_id is None
    assert msg.sender_is_owner is None
    assert msg.text is None
    assert msg.quoted is None
    assert msg.mentioned_jids is None
    assert msg.mentioned_participants is None
    assert msg.bot_mentioned is None
    assert msg.replied_to_bot is None
    assert msg.location is None
    assert msg.group_description is None
    assert msg.slash_command is None
    assert msg.command_handled is None
    assert msg.group_event is None
    assert msg.action_log is None


def test_raw_preserves_input_payload():
    msg_full = WhatsAppMessage.from_payload(FULL_PAYLOAD)
    msg_min = WhatsAppMessage.from_payload(MINIMAL_PAYLOAD)
    assert msg_full.raw == FULL_PAYLOAD
    assert msg_min.raw == MINIMAL_PAYLOAD


def test_from_payload_does_not_raise_on_missing_optional():
    # folderPath always present; drop an arbitrary optional and confirm no raise.
    payload = dict(MINIMAL_PAYLOAD)
    payload.pop("text", None)  # already absent, but be explicit
    msg = WhatsAppMessage.from_payload(payload)
    assert msg.text is None


def test_frozen_dataclass_is_immutable():
    msg = WhatsAppMessage.from_payload(MINIMAL_PAYLOAD)
    with pytest.raises(Exception):
        msg.text = "mutated"  # type: ignore[misc]
