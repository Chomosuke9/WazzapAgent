# wasocket/protocol.py
#
# Frozen dataclasses for every frame the WaSocket SDK sends/receives, plus the
# `encode`/`decode` helpers. These mirror the Node side
# (`src/protocol/types.ts`) field-for-field and implement the wire
# shapes in CONTRACT.md §1 / §6.
#
# Scope (Step 23):
#   - Dataclasses VERBATIM from CONTRACT.md §6 (Hello, HelloAck, every *Action,
#     every *Event, AckResult, ErrorResult).
#   - encode(frame) -> str : dataclass -> JSON string. Actions/acks use the
#     `{type, payload}` shape; control events (§1.5) place their fields at the
#     TOP LEVEL (no `payload` wrapper).
#   - decode(raw: str) -> tuple[str, object] : JSON string -> (type, parsed).
#     Unknown types return `(type, raw_dict)` so socket.py can still route them.
#   - camelCase wire fields <-> snake_case dataclass fields, centralized.
#
# Intentionally NOT here:
#   - No websockets / asyncio / socket code.
#   - No request_id generation (that is Step 25 / correlation.py).
#   - NOT the agent's bridge.history.WhatsAppMessage (a different type); the
#     SDK's WhatsAppMessage is defined separately in wasocket/events.py (Step 24).

import dataclasses
import json
import re
from dataclasses import dataclass
from typing import Any, Optional, get_origin

# ---------------------------------------------------------------------------
# Dataclasses — CONTRACT.md §6 (mirror of src/protocol/types.ts §5)
# ---------------------------------------------------------------------------


# ---- handshake ----
@dataclass(frozen=True)
class Hello:
    folder_path: str
    protocol_version: str = "2.0"


@dataclass(frozen=True)
class HelloAck:
    folder_path: str
    wa_status: str  # "open" | "connecting" | "close"


# ---- actions Python SENDS ----
@dataclass(frozen=True)
class SendMessageAction:
    request_id: str
    chat_id: str
    text: Optional[str] = None
    reply_to: Optional[str] = None
    attachments: Optional[list[dict]] = None


@dataclass(frozen=True)
class ReactMessageAction:
    request_id: str
    chat_id: str
    context_msg_id: str
    emoji: str


@dataclass(frozen=True)
class DeleteMessageAction:
    request_id: str
    chat_id: str
    context_msg_id: str


@dataclass(frozen=True)
class KickMemberAction:
    request_id: str
    chat_id: str
    targets: tuple[dict, ...]
    mode: str = "partial_success"
    auto_reply_anchor: bool = False


@dataclass(frozen=True)
class MarkReadAction:
    chat_id: str
    message_id: str
    participant: Optional[str] = None  # no request_id


@dataclass(frozen=True)
class SendPresenceAction:
    chat_id: str
    type: str  # no request_id


@dataclass(frozen=True)
class SendQuizAction:
    request_id: str
    chat_id: str
    question: str
    choices: tuple[dict, ...]
    reply_to: Optional[str] = None
    footer: Optional[str] = None


@dataclass(frozen=True)
class SendCopyCodeAction:
    request_id: str
    chat_id: str
    code: str
    display_text: str = "Copy Code"
    reply_to: Optional[str] = None
    quoted_preview_text: Optional[str] = None


@dataclass(frozen=True)
class RelayLottieStickerAction:
    request_id: str
    chat_id: str
    lottie_payload: str
    reply_to: Optional[str] = None


@dataclass(frozen=True)
class SendButtonsAction:
    request_id: str
    chat_id: str
    text: str
    buttons: tuple[dict, ...]
    footer: Optional[str] = None


@dataclass(frozen=True)
class SendCarouselAction:
    request_id: str
    chat_id: str
    cards: tuple[dict, ...]
    text: Optional[str] = None


@dataclass(frozen=True)
class RunCommandAction:
    request_id: str
    chat_id: str
    command: str
    context_msg_id: Optional[str] = None


# ---- events Python RECEIVES ----
@dataclass(frozen=True)
class WhatsAppStatusEvent:
    folder_path: str
    status: str
    instance_id: str
    reason: Optional[int] = None


@dataclass(frozen=True)
class ClearHistoryEvent:
    folder_path: str
    chat_id: str  # chat_id may be "global"


@dataclass(frozen=True)
class SetLlm2ModelEvent:
    folder_path: str
    chat_id: str
    model_id: Optional[str]


@dataclass(frozen=True)
class InvalidateLlm2ModelEvent:
    folder_path: str
    chat_id: str


@dataclass(frozen=True)
class InvalidateDefaultModelEvent:
    folder_path: str


@dataclass(frozen=True)
class InvalidateChatSettingsEvent:
    folder_path: str
    chat_id: str


@dataclass(frozen=True)
class SetSubagentEnabledEvent:
    folder_path: str
    chat_id: str
    enabled: bool


# (incoming_message is parsed into WhatsAppMessage — CONTRACT.md §7, in
#  wasocket/events.py; NOT bridge.history.WhatsAppMessage.)


# ---- ack / error ----
@dataclass(frozen=True)
class AckResult:
    request_id: str
    action: str
    ok: bool
    detail: str
    code: Optional[str] = None
    result: Optional[dict] = None


@dataclass(frozen=True)
class ErrorResult:
    message: str
    detail: str
    code: str  # an ErrorCode (CONTRACT.md §2)
    request_id: Optional[str] = None
    action: Optional[str] = None


# ---------------------------------------------------------------------------
# Frame registry — wire `type` string <-> dataclass.
#
# `control` marks the §1.5 control events whose fields live at the TOP LEVEL of
# the frame (no `payload` wrapper). Everything else uses `{type, payload}`.
# ---------------------------------------------------------------------------

# (dataclass, wire type, is_control_event)
_FRAME_TABLE: tuple[tuple[type, str, bool], ...] = (
    # handshake
    (Hello, "hello", False),
    (HelloAck, "hello_ack", False),
    # actions (Python -> Node)
    (SendMessageAction, "send_message", False),
    (ReactMessageAction, "react_message", False),
    (DeleteMessageAction, "delete_message", False),
    (KickMemberAction, "kick_member", False),
    (MarkReadAction, "mark_read", False),
    (SendPresenceAction, "send_presence", False),
    (SendQuizAction, "send_quiz", False),
    (SendCopyCodeAction, "send_copy_code", False),
    (RelayLottieStickerAction, "relay_lottie_sticker", False),
    (SendButtonsAction, "send_buttons", False),
    (SendCarouselAction, "send_carousel", False),
    (RunCommandAction, "run_command", False),
    # acks / errors (Node -> Python)
    (AckResult, "action_ack", False),
    (ErrorResult, "error", False),
    # payload-wrapped event (Node -> Python)
    (WhatsAppStatusEvent, "whatsapp_status", False),
    # control events (Node -> Python, §1.5 — TOP-LEVEL fields, no payload)
    (ClearHistoryEvent, "clear_history", True),
    (SetLlm2ModelEvent, "set_llm2_model", True),
    (InvalidateLlm2ModelEvent, "invalidate_llm2_model", True),
    (InvalidateDefaultModelEvent, "invalidate_default_model", True),
    (InvalidateChatSettingsEvent, "invalidate_chat_settings", True),
    (SetSubagentEnabledEvent, "set_subagent_enabled", True),
)

_TYPE_BY_CLASS: dict[type, str] = {cls: t for cls, t, _ in _FRAME_TABLE}
_CLASS_BY_TYPE: dict[str, type] = {t: cls for cls, t, _ in _FRAME_TABLE}
_CONTROL_CLASSES: frozenset[type] = frozenset(cls for cls, _, c in _FRAME_TABLE if c)
_CONTROL_TYPES: frozenset[str] = frozenset(t for _, t, c in _FRAME_TABLE if c)


def _tuple_field_names(cls: type) -> frozenset[str]:
    """Field names whose annotation is a ``tuple[...]`` (need list->tuple on decode)."""
    names = set()
    for f in dataclasses.fields(cls):
        if get_origin(f.type) is tuple:
            names.add(f.name)
    return frozenset(names)


_TUPLE_FIELDS: dict[type, frozenset[str]] = {
    cls: _tuple_field_names(cls) for cls, _, _ in _FRAME_TABLE
}
_FIELD_NAMES: dict[type, frozenset[str]] = {
    cls: frozenset(f.name for f in dataclasses.fields(cls)) for cls, _, _ in _FRAME_TABLE
}


# ---------------------------------------------------------------------------
# Centralized camelCase (wire) <-> snake_case (dataclass) conversion.
# ---------------------------------------------------------------------------

_CAMEL_BOUNDARY = re.compile(r"(?<!^)(?=[A-Z])")


def snake_to_camel(name: str) -> str:
    """``context_msg_id`` -> ``contextMsgId``."""
    head, *rest = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


def camel_to_snake(name: str) -> str:
    """``contextMsgId`` -> ``context_msg_id``."""
    return _CAMEL_BOUNDARY.sub("_", name).lower()


def _to_wire_body(frame: Any) -> dict:
    """dataclass -> camelCase wire dict (all fields, snake->camel keys)."""
    body: dict = {}
    for f in dataclasses.fields(frame):
        value = getattr(frame, f.name)
        if isinstance(value, tuple):
            value = list(value)
        body[snake_to_camel(f.name)] = value
    return body


# ---------------------------------------------------------------------------
# encode / decode
# ---------------------------------------------------------------------------


def encode(frame: Any) -> str:
    """Serialize a frame dataclass to a JSON wire string.

    Actions/acks/events use ``{type, payload}``; §1.5 control events place their
    fields at the TOP LEVEL with no ``payload`` wrapper.
    """
    cls = type(frame)
    type_str = _TYPE_BY_CLASS.get(cls)
    if type_str is None:
        raise TypeError(f"encode: unknown frame type {cls!r}")
    body = _to_wire_body(frame)
    if cls in _CONTROL_CLASSES:
        frame_dict = {"type": type_str, **body}
    else:
        frame_dict = {"type": type_str, "payload": body}
    return json.dumps(frame_dict)


def decode(raw: str) -> tuple[str, object]:
    """Parse a JSON wire string into ``(type, parsed_object)``.

    Known types return the matching frozen dataclass. Unknown types return
    ``(type, raw_dict)`` so the caller (socket.py) can still route them.
    """
    obj = json.loads(raw)
    type_str = obj.get("type")
    cls = _CLASS_BY_TYPE.get(type_str)
    if cls is None:
        return (type_str, obj)

    if cls in _CONTROL_CLASSES:
        wire_body = {k: v for k, v in obj.items() if k != "type"}
    else:
        wire_body = obj.get("payload") or {}

    field_names = _FIELD_NAMES[cls]
    tuple_fields = _TUPLE_FIELDS[cls]
    kwargs: dict = {}
    for wire_key, value in wire_body.items():
        snake = camel_to_snake(wire_key)
        if snake not in field_names:
            continue  # tolerate extra/unknown wire fields
        if snake in tuple_fields and isinstance(value, list):
            value = tuple(value)
        kwargs[snake] = value
    return (type_str, cls(**kwargs))


__all__ = [
    # handshake
    "Hello",
    "HelloAck",
    # actions
    "SendMessageAction",
    "ReactMessageAction",
    "DeleteMessageAction",
    "KickMemberAction",
    "MarkReadAction",
    "SendPresenceAction",
    "SendQuizAction",
    "SendCopyCodeAction",
    "RelayLottieStickerAction",
    "SendButtonsAction",
    "SendCarouselAction",
    "RunCommandAction",
    # events
    "WhatsAppStatusEvent",
    "ClearHistoryEvent",
    "SetLlm2ModelEvent",
    "InvalidateLlm2ModelEvent",
    "InvalidateDefaultModelEvent",
    "InvalidateChatSettingsEvent",
    "SetSubagentEnabledEvent",
    # ack / error
    "AckResult",
    "ErrorResult",
    # helpers
    "encode",
    "decode",
    "snake_to_camel",
    "camel_to_snake",
]
