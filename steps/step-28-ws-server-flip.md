# Step 28 — WS Server Flip (atomic cutover)

## Context
The one explicitly-named direction flip. Until now Node was the WS **client** and
Python the WS **server**. This step reverses it: Node boots the `wsServer`
(built in Phase 3) as its production transport, and Python's `main.py` stops
running `websockets.serve` and instead drives a `WaSocket` client (built in
Phase 4). The two changes **must ship together** — neither half works against the
other half's old form. The agent's per-chat logic and the `wa/` business logic
are preserved; only the transport seam moves.

## Contract references
- **CONTRACT.md §1.1** — `hello`/`hello_ack` is now the live handshake.
- **CONTRACT.md §1.2–§1.5** — Python now sends actions / receives events+control
  via `WaSocket`; Node now serves them via `wsServer`/`actionDispatcher`/
  `eventForwarder`.
- **CONTRACT.md §4** — the agent calls the `WaSocket` methods.
- **CONTRACT.md §8** — accounts created on connect ensure the tenant folder.

## Files to read before starting
- Original - `migration/node/index.ts` (`bootstrap`, the `dispatchCommand` copy)
- `migration/node/server/wsServer.ts` (Step 20), `migration/node/account/actionDispatcher.ts` (Step 19)
- `migration/python/bridge/main.py` (`handle_socket`, `main`, the `async for raw in ws`
  loop and its control-event branches, `_parse_endpoint`)
- `migration/python/bridge/messaging/gateway.py` (the `ws`-first-arg send_* helpers)
- `migration/python/wasocket/socket.py` (Step 27)
- CONTRACT.md §1, §4

## Files to create
None (all modules already exist from Phases 3–4).

## Files to modify
### `migration/node/index.ts`
**Change:** Replace `await startWhatsApp()` + `wsClient.connect()` with
`startWsServer(config.wsListenPort)`. Remove the in-file `dispatchCommand`
body and `wsClient.on('message', …)` (routing now lives in `actionDispatcher`
via `wsServer`). `index.ts` becomes the thin entry: `dbInit` (global, until
Step 33 per-tenant), start server, signal handling.
**Location:** `bootstrap()` and the `dispatchCommand`/`emitAction*` block.

### `migration/python/bridge/main.py`
**Change:** Replace `websockets.serve(handle_socket, …)` + the `async for raw in
ws` loop with: construct a `WaSocket` via `make_wa_socket(folder_path)`,
`await sock.connect(node_url)`, register `@sock.on("message")` → the existing
`incoming_message`-handling pipeline (mute gate, activation gate, role-change,
debounce/`pending_by_chat`, `process_message_batch`), `@sock.on("status")`,
and `@sock.on(<control event>)` handlers reusing the existing branch bodies
(`clear_history`, `set_llm2_model`, `invalidate_llm2_model`,
`invalidate_default_model`, `invalidate_chat_settings`, `set_subagent_enabled`).
Keep `handle_socket`'s per-chat state/closures intact (just hosted under the
WaSocket handlers).
**Location:** `handle_socket` body + `main()`.

### `migration/python/bridge/messaging/gateway.py`
**Change:** Re-point each `send_*` helper from `await ws.send(json.dumps({...}))`
to the corresponding `WaSocket` action method (the first arg `ws` becomes the
`WaSocket`). Signatures otherwise unchanged so call sites in `main.py` are stable.
**Location:** every `send_*` / `typing_indicator` helper.

## Files to delete
- The `websockets.serve` scaffolding inside `main.py` (`handle_socket` becomes
  handler bodies; `_parse_endpoint` is removed here or in Step 31).
- The `dispatchCommand`/`emitActionAck`/`emitActionError` copy in `index.ts`
  (canonical version is `actionDispatcher`).

## Behaviors that will break during this step
(The moment this lands, before/unless Step 29 is merged with it and Phase 6 scales out.)
- **Provisional-history hydration** breaks unless Step 29 lands in the same PR:
  `send_message` acks were consumed by the old `async for raw in ws` loop, which
  is removed here. Without Step 29, bot replies stay `context_msg_id="pending"`
  forever and `run_command`/sub-agent-attachment hydration stops.
- **The old Python WS server is gone**, so any *other* client that expected to
  connect to `LLM_WS_ENDPOINT` (e.g. `examples/llm_ws_echo.py` smoke harness,
  any external dashboard) can no longer connect — the direction is reversed.
- **`whatsapp_status` semantics**: values are now normalized to
  `open|connecting|close` (Step 18); any Python code that string-matched
  `"closed"` must read `"close"`.
- **Single-account assumption**: until Phase 6 wires N accounts, only one
  `folder_path` is driven; multi-account boot is not yet active.
- **In-flight messages/actions** crossing the wire during the deploy swap are
  dropped (no shared queue spans the topology change).
- **Auth path**: the first account now reads `<folderPath>/auth`; if the old
  `data/auth` is not mapped to that folder, the account prints a fresh QR.

## Rollback procedure
1. Revert this commit (and Step 29 if squashed in): `git revert <sha>` restores
   `migration/node/index.ts` (back to `startWhatsApp()` + `wsClient.connect()`) and
   `migration/python/bridge/main.py` (back to `websockets.serve(handle_socket)`).
2. No data migration is needed — DB schema and `wa/`/`bridge/` logic are
   unchanged by the flip; only the transport seam moved.
3. Restart both processes; the old topology (Node client → Python server on
   `LLM_WS_ENDPOINT`) resumes.
4. Auth state under `data/auth` is untouched by rollback (the per-folder auth is
   the same directory when only one account is mapped), so no re-pair is needed
   if the folder mapping was a symlink/identity.

## Verification before merging
Confirm Node accepts `WaSocket` connections correctly **before** disconnecting
the old Python bridge, in staging:
1. Start the new Node (`node dist/index.js` / `pnpm dev`) on `WS_LISTEN_PORT`.
2. Run a standalone script (not the agent): `make_wa_socket(folder_path)` +
   `await sock.connect("ws://localhost:3000")`; assert the `"ready"` event fires
   (i.e. `hello_ack` received) and `sock.is_connected` is `True`.
3. From that script `await sock.send_message(test_chat, "ping")` and assert it
   returns a `result` with `sent[0].contextMsgId` (round-trip through
   `actionDispatcher` → Baileys → ack).
4. Trigger an inbound WhatsApp message to the paired account and assert the
   script's `@sock.on("message")` handler receives a `WhatsAppMessage` with the
   correct `folder_path`.
5. Run `/reset` in the chat and assert the script's `@sock.on("clear_history")`
   handler fires.
6. Only after 1–5 pass, cut the agent over (point `main.py` at the server) and
   decommission the old Python WS server.

## Acceptance criteria
- `pnpm typecheck` passes; `node dist/index.js` (or `pnpm dev`) starts a WS server
  on `WS_LISTEN_PORT` without error and **no** longer dials `LLM_WS_ENDPOINT`.
- `python -m python.bridge.main` starts, connects to the server, and logs the
  `ready` (`hello_ack`) for its `folder_path`.
- End-to-end on staging (single account): inbound message → LLM1/LLM2 →
  `send_message` → WhatsApp; `/reset`, `/model`, mute enforcement, a quiz
  round-trip, and a sub-agent task all behave as before.
- `node --test 'tests/node/**/*.test.mjs'` and `pytest migration/python/tests/` green.

## Must NOT do
- Do not land this without Step 29 in the same PR (hydration would break).
- Do not change agent batching/debounce/LLM logic or `wa/` business logic.
- Do not delete `wsClient.ts` here (Step 30) or remove `websockets` from
  requirements (Step 31 — the SDK still needs the client).
- Do not introduce multi-account boot here (Phase 6).

## Depends on
Step 20, Step 21, Step 27. **Merges atomically with Step 29.**
