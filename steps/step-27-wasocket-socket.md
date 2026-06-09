# Step 27 — `wasocket/socket.py` + `__init__.py`

## Context
Assemble the public SDK: `WaSocket` ties transport + protocol + correlation +
events together, exposing the lifecycle, `on(...)` event registration, and the
action methods. This is the surface the agent will use in Phase 5.

## Contract references
- **CONTRACT.md §4** — the complete public interface (signatures, async, raises,
  fire-and-forget vs await-ack) — implements it verbatim.
- **CONTRACT.md §1.2/§1.3** — action frames out, ack/error in.
- **CONTRACT.md §1.4/§1.5** — events surfaced to handlers.
- **CONTRACT.md §3** — `request_id` via `correlation.make_request_id`.
- **CONTRACT.md §7** — `"message"` handler receives a `WhatsAppMessage`.

## Files to read before starting
- Original - CONTRACT.md §4 (primary), §1–§3, §7
- `migration/python/wasocket/{transport,protocol,correlation,events,errors}.py` (Steps 22–26)
- `migration/python/bridge/messaging/gateway.py` (canonical action frame shapes to mirror)

## Files to create
### `migration/python/wasocket/socket.py`
**Purpose:** `WaSocket` public API + `make_wa_socket` factory.
**Exports:** `make_wa_socket(folder_path) -> WaSocket`; `class WaSocket`.
**Must NOT contain:** any agent/LLM/DB logic; any `bridge.*` import.
**Key logic (per CONTRACT.md §4):**
- lifecycle `connect`/`disconnect`/`is_connected`/`folder_path`.
- `on(event)` decorator storing handlers per event name (CONTRACT.md §4 list).
- action methods build frames via `protocol.py`, allocate `request_id` via
  `correlation.make_request_id`, send via `transport`, then **await** the ack
  future and return its `result` (raising the mapped `WaSocketError` on
  `error`/failed-ack/timeout). `mark_read`/`send_presence` send and return
  immediately (no future).
- frame router (the transport's `on_frame`): `incoming_message`→`"message"`
  (`WhatsAppMessage.from_payload`); `whatsapp_status`→`"status"`;
  `hello_ack`→`"ready"`; `error`→reject future **and** emit `"error"`;
  `action_ack`/`send_ack`→resolve future **and** re-emit as events (D3);
  control events→emit by their type name.

### `migration/python/wasocket/__init__.py`
**Purpose:** Package surface.
**Exports:** `make_wa_socket`, `WaSocket`, `WhatsAppMessage` (+ the
`WaSocketError` hierarchy for convenience).
**Must NOT contain:** logic.

## Files to create (test support)
### `migration/python/tests/stub_node_server.py`
**Purpose:** A minimal asyncio WS server implementing the CONTRACT.md handshake +
echoing canned acks/events, for SDK integration tests (used when the real
Step 20 `wsServer` is not run).
**Key logic:** accept `hello`→reply `hello_ack`; on a `send_message` action reply
`action_ack`(ok)+`send_ack`; on `delete_message` with a sentinel bad id reply an
`error` `not_found`; can push an `incoming_message` and a `clear_history`.

## Acceptance criteria
- `pytest migration/python/tests/test_socket.py` (against `stub_node_server.py`, or the
  Step 20 `wsServer`):
  - `await sock.connect()` fires the `"ready"` handler after `hello_ack`.
  - `await sock.send_message(chat, "hi")` returns the `result` dict with
    `sent[...]`.
  - `await sock.delete_message(chat, "<bad>")` raises `NotFoundError`.
  - an emitted `incoming_message` invokes the `@sock.on("message")` handler with
    a `WhatsAppMessage` whose `folder_path` matches.
  - an emitted `clear_history` invokes the `@sock.on("clear_history")` handler.
  - `mark_read` returns `None` and registers no pending future.
- `python -c "from python.wasocket import make_wa_socket, WaSocket, WhatsAppMessage"`
  succeeds.

## Must NOT do
- Do not import anything from `migration/python/bridge/` (SDK is agent-agnostic).
- Do not wire the SDK into `main.py` yet (Step 28).
- Do not add `request_id` formats or error codes not in CONTRACT.md.

## Depends on
Step 24, Step 26.
