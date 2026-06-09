# Step 29 — Reconcile provisional-history hydration (D3)

## Context
The old `async for raw in ws` loop in `main.py` handled `action_ack`/`send_ack`
to hydrate provisional history (`context_msg_id="pending"` →
real 6-digit id), record sub-agent attachment paths, and append the
`run_command` "executed" line. Step 28 removes that loop. This step re-homes
those handlers onto the SDK's re-emitted `action_ack` event (CONTRACT.md §4 /
decision D3, option **b**) so behavior is preserved verbatim.

## Contract references
- **CONTRACT.md §4** — `WaSocket.on("action_ack")`/`on("send_ack")` receive an
  `AckResult`; the SDK re-emits acks as events in addition to resolving futures.
- **CONTRACT.md §1.3** — `action_ack.result` shapes (`send_message` →
  `{ sent: [...] }`, `run_command` → `{ command }`).
- **CONTRACT.md §6** — `AckResult` dataclass.

## Files to read before starting
- `python/bridge/main.py` — the `event_type in {"send_ack","action_ack"}` block
  (the `send_message` hydration, `pending_send_request_chat`,
  `pending_subagent_attachments`, and `run_command` ack branches)
- `python/bridge/messaging/processing.py` —
  `_hydrate_provisional_context_id_from_ack`, `_extract_send_ack_context_msg_id`,
  `_extract_all_send_ack_entries`
- `python/wasocket/socket.py` (Step 27 — the `action_ack` event)

## Files to create
None.

## Files to modify
### `python/bridge/main.py`
**Change:** Add `@sock.on("action_ack")` (and `@sock.on("send_ack")` if needed)
handlers whose bodies are the moved logic from the old loop's ack block:
`send_message` provisional hydration via
`_hydrate_provisional_context_id_from_ack`, sub-agent attachment path storage
into `media_paths_by_chat` via `_extract_all_send_ack_entries`, and the
`run_command` synthetic "Command X executed/failed" history line. Keep
`pending_send_request_chat`/`pending_subagent_attachments`/
`pending_run_command_chat` as before. Where a call site finds the awaited
`send_message` return value simpler (D3 option a), it may hydrate inline instead
— but the provisional-entry path must remain correct.
**Location:** the new WaSocket-handler region created in Step 28 (replacing the
removed `action_ack`/`send_ack` loop branch).

## Files to delete
None (the old loop block is removed by Step 28).

## Acceptance criteria
- `pytest python/tests/test_hydration.py` (driving the agent's ack handler with a
  synthetic `AckResult`):
  - a provisional entry (`context_msg_id="pending"`,
    `message_id="local-send-<rid>"`) becomes the real 6-digit id after an
    `action_ack` for that `requestId`.
  - a sub-agent attachment `action_ack` stores the file path in
    `media_paths_by_chat` under the real `contextMsgId`.
  - a `run_command` `action_ack` (`ok=true`) appends
    `"Command <name> executed successfully"` to that chat's history; `ok=false`
    appends the failure line.
- End-to-end (with Step 28): a bot reply's history entry shows a real
  `contextMsgId` (not `pending`) after the round trip.

## Must NOT do
- Do not change the wire ack shapes (SDK re-emits as-is).
- Do not alter the dedup/echo-merge logic.
- Do not land separately from Step 28.

## Depends on
Step 28 (merges atomically with it).
