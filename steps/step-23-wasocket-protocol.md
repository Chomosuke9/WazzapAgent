# Step 23 — `wasocket/protocol.py`

## Context
Define the frozen dataclasses for every frame the SDK sends/receives, plus
encode/decode helpers and the handshake types. These mirror the Node
`migration/node/protocol/types.ts` field-for-field so the two sides cannot drift.

## Contract references
- **CONTRACT.md §6** — implements the dataclasses verbatim (`Hello`, `HelloAck`,
  every `*Action`, every `*Event`, `AckResult`, `ErrorResult`).
- **CONTRACT.md §1** — the exact JSON shapes that `to_frame`/`from_frame` produce
  and parse (including the **top-level** control-event shape, no `payload`
  wrapper, §1.5).
- **CONTRACT.md §3** — `request_id` is a plain field here (generated in Step 25).

## Files to read before starting
- Original - CONTRACT.md §1, §6
- `migration/node/protocol/types.ts` (Step 09 — the mirror)
- `migration/python/bridge/messaging/gateway.py` (the current action JSON shapes)

## Files to create
### `migration/python/wasocket/protocol.py`
**Purpose:** Frozen dataclasses + `encode`/`decode`.
**Exports:** every dataclass named in CONTRACT.md §6, plus
- `encode(frame) -> str` — dataclass → JSON string `{type, payload}` (or
  top-level control shape for §1.5 events).
- `decode(raw: str) -> tuple[str, object]` — JSON string → `(type, parsed)`.
**Must NOT contain:** any WS/socket/asyncio code; any `request_id` generation
(Step 25); the agent's `bridge.history.WhatsAppMessage` (different type).
**Key logic:** camelCase wire fields ↔ snake_case dataclass fields
(`folderPath`↔`folder_path`, `chatId`↔`chat_id`, `requestId`↔`request_id`, etc.).
Control events (§1.5) serialize with their fields at the **top level**, not under
`payload`. `decode` returns the frame `type` plus the matching parsed object;
unknown types return `(type, raw_dict)` so `socket.py` can still route them.

## Files to modify
None.

## Files to delete
None.

## Acceptance criteria
- `pytest migration/python/tests/test_protocol.py`:
  - round-trip: `decode(encode(x)) == x` for one instance of every action and
    every event dataclass.
  - a golden JSON sample of each action (taken from `gateway.py` / CONTRACT.md
    §1) decodes without field loss.
  - a control event (e.g. `clear_history`) encodes with `chatId`/`folderPath`
    at the **top level** (no `payload` key).
  - camelCase↔snake_case mapping verified on `SendMessageAction`
    (`reply_to`→`replyTo`).
- `python -c "import python.wasocket.protocol"` imports cleanly.

## Must NOT do
- Do not generate `request_id`s here.
- Do not open sockets or import `websockets`.
- Do not diverge field names from `migration/node/protocol/types.ts`.

## Depends on
Step 22.
