# Step 24 — `wasocket/events.py`

## Context
Define the SDK event-name constants and the canonical inbound `WhatsAppMessage`
model parsed from `incoming_message`. This model is shared by the SDK and the
agent and is **not** the agent's internal `bridge.history.WhatsAppMessage`.

## Contract references
- **CONTRACT.md §7** — `WhatsAppMessage` fields (presence + types) verbatim.
- **CONTRACT.md §4** — the `event` strings accepted by `WaSocket.on(...)`.
- **CONTRACT.md §1.4/§1.5** — the Node→Python events these constants name.

## Files to read before starting
- CONTRACT.md §4, §7, §1.4, §1.5
- `src/wa/inbound.ts` (the `incoming_message` payload literal — the source of §7)
- `python/bridge/history.py` (`WhatsAppMessage`) — to confirm this is a
  **different** type and avoid confusion

## Files to create
### `python/wasocket/events.py`
**Purpose:** Event-name constants + `WhatsAppMessage` inbound model.
**Exports:**
- Constants: `MESSAGE="message"`, `STATUS="status"`, `READY="ready"`,
  `ERROR="error"`, `ACTION_ACK="action_ack"`, `SEND_ACK="send_ack"`,
  `CLEAR_HISTORY="clear_history"`, `SET_LLM2_MODEL="set_llm2_model"`,
  `INVALIDATE_LLM2_MODEL="invalidate_llm2_model"`,
  `INVALIDATE_DEFAULT_MODEL="invalidate_default_model"`,
  `INVALIDATE_CHAT_SETTINGS="invalidate_chat_settings"`,
  `SET_SUBAGENT_ENABLED="set_subagent_enabled"`.
- `@dataclass(frozen=True) class WhatsAppMessage` with **exactly** the
  CONTRACT.md §7 fields (snake_case), required fields without defaults, optional
  fields defaulting to `None`.
- `WhatsAppMessage.from_payload(payload: dict) -> WhatsAppMessage` — builds from
  the `incoming_message` payload (camelCase→snake_case).
- A `raw: dict` field preserving the original payload (so the agent can read any
  field not promoted to an attribute).
**Must NOT contain:** any transport/asyncio code; the agent's history dataclass;
event-dispatch logic (Step 27).
**Key logic:** `folderPath` is **always present** (§7); optional fields map to
`None` when absent. `from_payload` must not raise on a missing optional.

## Files to modify
None.

## Files to delete
None.

## Acceptance criteria
- `pytest python/tests/test_events.py`:
  - a full `incoming_message` payload (from README/CONTRACT §7) parses into a
    `WhatsAppMessage` with every field populated and `folder_path` set.
  - a minimal payload (only the "Always" fields) parses without error and
    optional fields are `None`.
  - `msg.raw` equals the input payload.
- `python -c "import python.wasocket.events"` imports cleanly.

## Must NOT do
- Do not import or subclass `bridge.history.WhatsAppMessage`.
- Do not add event-dispatch or `on()` logic (Step 27).
- Do not open sockets.

## Depends on
Step 23.
