# Step 28 — WS Server Flip (atomic cutover) — Verification Report

## 1. Verdict: ACCURATE

The atomic transport flip described by Step 28 is faithfully implemented in the
final `migration/` tree. Node now boots the `wsServer` as its production
transport and no longer dials out; Python's `main.py` no longer runs
`websockets.serve` and instead drives `WaSocket` client(s) via
`make_wa_socket`. The per-chat agent logic and `wa/` business logic are
preserved. The only meaningful deviation from the literal spec text is in
`gateway.py` (it routes pre-built JSON frames through `ws._transport.send`
rather than calling the high-level `WaSocket` action methods) — this is
deliberate, documented, and contract-correct (see Issues). Note: the repo is at
the cumulative end-state, so `main.py` already carries the Step 32/33
session-extraction + multi-account boot; those are out of Step 28's scope but
do not contradict it.

## 2. Acceptance-criteria checklist

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | `pnpm typecheck` passes; Node starts a WS server on `WS_LISTEN_PORT` and no longer dials `LLM_WS_ENDPOINT` | PASS (static) | `migration/node/index.ts:29` `wss = startWsServer(config.wsListenPort)`; no `wsClient`/`startWhatsApp`/`LLM_WS_ENDPOINT` references remain in `index.ts`. `config.ts:86` parses `WS_LISTEN_PORT` (default 3000). Could not run `tsc`; judged by reading. |
| 2 | `python -m python.bridge.main` connects to the server and logs the `ready` (`hello_ack`) for its `folder_path` | PASS (static) | `main.py` builds `make_wa_socket(folder_path)` + `AgentSession`; `session.py::AgentSession.run` calls `await ws.connect(node_url)`; `_register_handlers` wires `@ws.on("ready")` → `logger.info("Gateway connected (ready)")`. `WaSocket._on_transport_status("open")` fires `ready` after `hello_ack`. |
| 3 | End-to-end staging (inbound→LLM1/LLM2→send_message; /reset, /model, mute, quiz, sub-agent) behaves as before | PASS (static, not executed) | The former `handle_socket` pipeline is re-homed verbatim in `session.py::_register_handlers` (`_dispatch_event` carries the control-event + incoming_message branch bodies; mute gate, activation gate, role-change, debounce/`pending_by_chat`, `process_message_batch`). Per rules, not run. |
| 4 | `node --test` and `pytest` green | NOT RUN | Prohibited by task rules (global gates run centrally). |

## 3. Files-to-modify checklist

- `migration/node/index.ts` — PASS. Thin entry: `dbInit()` → `startWsServer(config.wsListenPort)` → SIGINT/SIGTERM shutdown that `wss.close()` + `closeAllDbs()`. In-file `dispatchCommand`/`emitAction*` and `wsClient.on('message')` are gone (routing now in `account/actionDispatcher.ts`, wired through `wsServer`).
- `migration/python/bridge/main.py` — PASS. `websockets.serve(handle_socket, …)` and the `async for raw in ws` loop are removed; replaced by `WaSocket` + `AgentSession` lifecycle.
- `migration/python/bridge/messaging/gateway.py` — PASS w/ deviation. Every `send_*`/`typing_indicator` helper now takes a `WaSocket` as first arg `ws` and sends via `_ws_send(ws, frame)` → `ws._transport.send(frame)`. Signatures unchanged, so `session.py` call sites are stable.

## 4. Files-to-delete checklist

- `websockets.serve` scaffolding in `main.py` — GONE (grep: zero matches anywhere in `migration/`).
- `_parse_endpoint` — GONE (zero matches in `migration/`).
- `LLM_WS_ENDPOINT` — GONE (zero matches in `migration/`).
- `dispatchCommand`/`emitActionAck`/`emitActionError` copy in `index.ts` — GONE (index.ts is the thin entry; canonical dispatcher is `actionDispatcher.ts`).
- Residual `handle_socket`/`startWhatsApp`/`wsClient` matches are only docstrings/comments or the renamed `baileysFactory`/`WSClientTransport` ports — not live old-topology code paths.

## 5. Issues

- [MINOR] `migration/python/bridge/messaging/gateway.py:_ws_send` (and all `send_*` helpers) — Deviates from the literal spec ("re-point each `send_*` helper to the corresponding `WaSocket` action method"). It instead keeps building `json.dumps({...})` frames and routes them through the SDK's private `ws._transport.send`. Rationale is documented in the `_ws_send` docstring and is sound: the high-level `WaSocket` methods allocate their OWN `requestId` and AWAIT the ack, whereas the bridge must keep its own `_make_request_id` on the wire so the Step-29 `action_ack` handler can correlate provisional-history hydration / `pending_send_request_chat` / `pending_subagent_attachments` / `pending_run_command_chat`. Functionally achieves the flip and preserves CONTRACT §1.6 best-effort semantics for action frames. Concern is only encapsulation (reaching into a private `_transport` attribute).
- [MINOR] `migration/python/bridge/session.py` `_dispatch_event` — the `if event_type == "error"` branch is dead code: `error` frames are delivered via the separate `@ws.on("error")` → `_on_error` handler, never through `_dispatch_event`. Harmless (both just log a warning).

## 6. Must-NOT-do compliance

- "Do not land without Step 29 (hydration)" — SATISFIED. Step 29 hydration is present and merged atomically: `@ws.on("action_ack")` → `_handle_action_ack(...)` with `pending_send_request_chat` / `pending_subagent_attachments` / `pending_run_command_chat` / `media_paths_by_chat`. Provisional `context_msg_id="pending"` entries are created and hydrated on ack.
- "Do not change agent batching/debounce/LLM logic or `wa/` business logic" — SATISFIED. The batching/debounce/LLM1/LLM2/sub-agent bodies are re-homed verbatim in `session.py` (later relocation by Step 32, logic unchanged).
- "Do not delete `wsClient.ts` here (Step 30)" — `wsClient.ts` is absent from the final tree, but that deletion belongs to Step 30; Step 28's `index.ts` simply stops importing it. Not a Step 28 violation. (Noted as a cumulative-repo observation.)
- "Do not introduce multi-account boot here (Phase 6)" — `main.py` does now contain multi-account boot, but that was introduced by Step 33, not Step 28. In the cumulative end-state this is expected and does not contradict Step 28's flip.

## 7. Contract / isolation notes

- Handshake (CONTRACT §1.1): `wsServer.ts::handleHello` requires `hello` as the first frame, calls `createOrResumeAccount({folderPath})`, sends `hello_ack {folderPath, waStatus}` BEFORE `bindClient`/`flushReliableQueue` — correct ordering for reliable-queue delivery after handshake.
- Control events (§1.5): emitted by `WaSocket._control_dict` as top-level camelCase fields + `type`; `session.py` handlers read `event.get("chatId")` / `event.get("modelId")` / `event.get("enabled")` at top level — consistent (no `payload` wrapper), matching CONTRACT.
- `incoming_message` is re-wrapped as `{"type":"incoming_message","payload": msg.raw}` so the verbatim pipeline runs unchanged.
- Per-tenant isolation: each `AgentSession` owns its state; `run()` binds `self.folder_path` to the DB ContextVar before `connect()` spawns the pump, so all DB access resolves under `<folder_path>/db`. Sub-agent tracker/client/webhook are per-session. No shared mutable cross-tenant state observed in the flipped seam.
- Teardown: `wsServer.ts` clears the heartbeat interval on `wss.close()` (and `unref()`s it); `index.ts` awaits `wss.close()` then `closeAllDbs()` on SIGINT/SIGTERM; `WSClientTransport.close()` cancels supervisor/heartbeat/grace timers. No leaked intervals/sockets in the Step-28 path.
