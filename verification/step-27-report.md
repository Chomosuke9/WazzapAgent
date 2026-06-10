# Step 27 Verification Report — `wasocket/socket.py` + `__init__.py`

## (1) Verdict: ACCURATE

The `WaSocket` public SDK and package surface are implemented verbatim against
CONTRACT.md §4 (with §1.2/§1.3/§1.4/§1.5/§3/§7 wired correctly). All "Files to
create" exist and match their stated purpose/exports/key-logic. No "Must NOT do"
violations. One MINOR robustness gap (unused `reject_all` on disconnect).

Files verified:
- `migration/python/wasocket/socket.py` — `WaSocket` + `make_wa_socket` ✔
- `migration/python/wasocket/__init__.py` — package surface ✔
- `migration/python/tests/stub_node_server.py` — stub WS server ✔
- `migration/python/tests/test_socket.py` — acceptance tests ✔
- Cross-checked supporting modules: `protocol.py`, `correlation.py`,
  `events.py`, `transport.py`, `errors.py`.

## (2) Acceptance-criteria checklist

| Criterion | Status | Evidence |
|-----------|--------|----------|
| `connect()` fires `"ready"` after `hello_ack` | PASS | Transport handshake → `_emit_status("open")` (awaited) fires READY before `_ready_event.set()`; `connect()` blocks on that event. `test_connect_fires_ready` asserts `ready_hits == [True]` before connect returns. |
| `send_message(chat,"hi")` returns `result` dict with `sent[...]` | PASS | `_await_ack` registers future, sends frame, returns `ack.result`. `test_send_message_returns_result_with_sent` asserts `result["sent"][0]["contextMsgId"]`. |
| `delete_message(chat,"<bad>")` raises `NotFoundError` | PASS | Error frame → `errors.from_error_frame` (code `not_found` → `NotFoundError`) → `_pending.reject`. Test asserts `raised.code == "not_found"`. |
| emitted `incoming_message` → `@on("message")` with `WhatsAppMessage` whose `folder_path` matches | PASS | Router builds `WhatsAppMessage.from_payload(payload)`; `from_payload` reads `folderPath`. Test asserts `msg.folder_path == FOLDER`. |
| emitted `clear_history` → `@on("clear_history")` | PASS | Control event routed via `_CONTROL_TYPES`; `_control_dict` emits `{type, folderPath, chatId}`. Test asserts payload fields. |
| `mark_read` returns `None`, registers no future | PASS | Fire-and-forget: `transport.send` then `return None`, no `_pending.register`. Test asserts `result is None` and `_pending._futures == {}`. Same for `send_presence`. |
| `from python.wasocket import make_wa_socket, WaSocket, WhatsAppMessage` succeeds | PASS (static) | `__init__.py` re-exports all three (+ error hierarchy). No circular import (socket imports lower layers; none import socket). |

## (3) Issues

- [MINOR] migration/python/wasocket/socket.py:~205 (`disconnect`) — `disconnect()`
  closes the transport but never rejects in-flight pending-ack futures.
  `PendingAcks.reject_all(...)` exists in `correlation.py:106` and its docstring
  states it is "used on disconnect", but it is never called anywhere in the SDK.
  Consequence: an `await sock.send_message(...)` in flight when `disconnect()` is
  called will not fail fast — it hangs until the per-request ack timeout
  (default 30s) then raises `TimeoutError`. Not a contract violation (CONTRACT §3
  permits ack-wait expiry), but `reject_all` is effectively dead code and the
  fast-fail-on-disconnect behavior implied by its docstring is missing.

- [MINOR] migration/python/wasocket/socket.py (`_route_frame` `error` branch) —
  `errors.from_error_frame` is fed `message` from `ErrorResult.message`, but
  `from_error_frame` only reads `code`/`detail`/`requestId`/`action` (it falls
  back to `payload["message"]` only when `detail` is falsy). Behavior is correct
  per CONTRACT §1.3; noting only that `message` is passed but largely unused.
  No functional impact.

No BLOCKER or MAJOR issues found.

## (4) "Must NOT do" / isolation / contract notes

- **No `bridge.*` import**: confirmed via grep over `migration/python/wasocket/` —
  the only `bridge` match is in a comment/docstring context elsewhere; `socket.py`
  imports only `errors`, `events`, `protocol`, `correlation`, `transport`. PASS.
- **No agent/LLM/DB logic**: PASS — module is pure transport/protocol glue.
- **Not wired into `main.py`**: PASS — no `main` reference; Step 28 left untouched.
- **No request_id formats / error codes outside CONTRACT**: PASS — request ids use
  `correlation.make_request_id` (`<tag>-<unix_ms>-<seq6>`, §3); tags are category
  tags ("send", "react", "delete", "kick", "quiz", "buttons", "carousel", "copy",
  "sticker", "cmd") which §3 explicitly permits ("a category tag, not necessarily
  the exact action type"). Error codes come solely from `errors.CODE_TO_CLASS`
  (the six §2 codes). PASS.
- **Frame shapes / top-level vs payload**: control events correctly emitted with
  top-level `folderPath`/`chatId`/`modelId`/`enabled` + `type` (§1.5); actions use
  `{type, payload}` via `protocol.encode`. `whatsapp_status` surfaced as
  `{status, reason, folderPath}` (§4). PASS.
- **fire-and-forget**: only `mark_read` and `send_presence` skip the ack future
  (§4). PASS.
- **D3 dual-surface**: `action_ack`/`send_ack` both resolve/observe — `action_ack`
  resolves the future AND re-emits as event; `send_ack` re-emits only (no
  re-resolve, since `action_ack` is authoritative). PASS.
- **Per-account isolation**: `WaSocket` holds per-instance `_pending`, `_handlers`,
  `_transport`, `_folder_path`. The only process-global shared state is the
  `correlation._counter` (mandated shared by §3). No cross-tenant mutable leak. PASS.
- **Handler isolation / pump safety**: `_emit` and `_route_frame` wrap handler
  dispatch in try/except so a raising handler cannot kill the transport frame
  pump. PASS.
