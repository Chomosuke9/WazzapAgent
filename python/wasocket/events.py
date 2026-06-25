# wasocket/events.py
#
# SDK event-name constants + the canonical inbound `WhatsAppMessage` model
# parsed from an `incoming_message` payload (CONTRACT.md §7).
#
# Scope (Step 24):
#   - Event-name string constants accepted by `WaSocket.on(...)` (CONTRACT.md §4)
#     and the §1.4/§1.5 Node->Python events they name.
#   - `WhatsAppMessage`: a `@dataclass(frozen=True)` with EXACTLY the CONTRACT.md
#     §7 fields (snake_case). `Always` fields are required (no default); `Optional`
#     fields default to `None`. A `raw: dict` field preserves the original
#     payload so the agent can read any field not promoted to an attribute.
#   - `WhatsAppMessage.from_payload(payload)`: camelCase->snake_case builder.
#     `folderPath` is always present; missing optionals map to `None`; it MUST
#     NOT raise on a missing optional.
#
# Intentionally NOT here:
#   - No websockets / asyncio / socket / transport code.
#   - NOT the agent's `bridge.history.WhatsAppMessage` (a different type); this
#     SDK model is defined independently and must never import/subclass it.
#   - No event-dispatch / `on()` logic (that is Step 27).

from dataclasses import dataclass, field, fields
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Event-name constants
#
# Stream/lifecycle events (CONTRACT.md §4) + the six Node->Python control events
# (CONTRACT.md §1.5). Values are the exact wire strings.
# ---------------------------------------------------------------------------

# stream / lifecycle events the agent subscribes to via WaSocket.on(...)
MESSAGE = "message"
STATUS = "status"
READY = "ready"
ERROR = "error"
ACTION_ACK = "action_ack"
SEND_ACK = "send_ack"

# control events (Node -> Python, CONTRACT.md §1.5)
CLEAR_HISTORY = "clear_history"
SET_LLM2_MODEL = "set_llm2_model"
INVALIDATE_LLM2_MODEL = "invalidate_llm2_model"
INVALIDATE_DEFAULT_MODEL = "invalidate_default_model"
INVALIDATE_CHAT_SETTINGS = "invalidate_chat_settings"
SET_SUBAGENT_ENABLED = "set_subagent_enabled"
SCHEDULE_TASK = "schedule_task"


from .protocol import camel_to_snake, snake_to_camel


# ---------------------------------------------------------------------------
# WhatsAppMessage — CONTRACT.md §7 (the SDK's incoming_message model).
#
# NOTE: dataclasses require non-default fields before default fields, so the
# CONTRACT.md §7 `Always` fields (required, no default) are declared first, then
# the `Optional` fields (default `None`). Relative §7 order is preserved within
# each group. `raw` (the original payload) is declared last.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class WhatsAppMessage:
    # --- Always (required, no default) — CONTRACT.md §7 ---
    folder_path: str
    instance_id: str
    chat_id: str
    chat_name: str
    chat_type: str  # "group" | "private"
    message_id: str
    sender_id: str
    sender_ref: str
    sender_name: str
    sender_is_admin: bool
    sender_is_super_admin: bool
    is_group: bool
    bot_is_admin: bool
    bot_is_super_admin: bool
    from_me: bool
    context_only: bool
    trigger_llm1: bool
    timestamp_ms: int
    message_type: str
    attachments: list  # Always (may be [])

    # --- Optional (default None) — CONTRACT.md §7 ---
    context_msg_id: Optional[str] = None
    sender_is_owner: Optional[bool] = None
    text: Optional[str] = None
    quoted: Optional[dict] = None
    mentioned_jids: Optional[list] = None
    mentioned_participants: Optional[list] = None
    bot_mentioned: Optional[bool] = None
    replied_to_bot: Optional[bool] = None
    location: Optional[dict] = None
    group_description: Optional[str] = None
    slash_command: Optional[dict] = None
    command_handled: Optional[bool] = None
    group_event: Optional[dict] = None
    action_log: Optional[dict] = None

    # --- original payload (everything as received) ---
    raw: dict = field(default_factory=dict)

    @classmethod
    def from_payload(cls, payload: dict) -> "WhatsAppMessage":
        """Build a `WhatsAppMessage` from an `incoming_message` payload.

        Converts camelCase wire keys to snake_case attributes. `folderPath` is
        always present (CONTRACT.md §7). Missing optional fields map to `None`.
        Never raises on a missing optional — fields absent from `payload`
        simply fall back to `None` (or `[]` for `attachments`).
        """
        payload = payload or {}
        kwargs: dict[str, Any] = {}
        for f in fields(cls):
            if f.name == "raw":
                continue
            wire_key = snake_to_camel(f.name)
            if wire_key in payload:
                kwargs[f.name] = payload[wire_key]
            elif f.name == "attachments":
                kwargs[f.name] = []
            else:
                kwargs[f.name] = None
        kwargs["raw"] = payload
        return cls(**kwargs)


__all__ = [
    # stream / lifecycle events
    "MESSAGE",
    "STATUS",
    "READY",
    "ERROR",
    "ACTION_ACK",
    "SEND_ACK",
    # control events
    "CLEAR_HISTORY",
    "SET_LLM2_MODEL",
    "INVALIDATE_LLM2_MODEL",
    "INVALIDATE_DEFAULT_MODEL",
    "INVALIDATE_CHAT_SETTINGS",
    "SET_SUBAGENT_ENABLED",
    "SCHEDULE_TASK",
    # model
    "WhatsAppMessage",
    # helpers
    "camel_to_snake",
    "snake_to_camel",
]
