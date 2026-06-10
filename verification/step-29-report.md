# Step 29 — Reconcile provisional-history hydration (D3) — Verification Report

## (1) Verdict: ACCURATE

The Step 29 behavior (re-homing the old `action_ack`/`send_ack` loop hydration
logic onto the SDK's re-emitted `action_ack` event, D3 option **b**) is fully
implemented and byte-for-byte preserved. The logic lives in a small,
dependency-light module `migration/python/bridge/messaging/ack_handler.py`
(`handle_action_ack`), wired via `@ws.on("action_ack")` in `session.py`. All
three hydration behaviors are preserved and the unit test
`migration/python/tests/test_hydration.py` exercises them.

Note: Because of the later Step 32/33 refactor, the `@sock.on("action_ack")`
handler does NOT live directly in `main.py` as the (pre-refactor) spec text
literally says; it lives in `session.py::_register_handlers` and delegates to
`ack_handler.handle_action_ack`. This is a file-location divergence from the
spec prose only — the spec explicitly allows it to live in "the new
WaSocket-handler region created in Step 28", and extracting it into
`ack_handler.py` is what makes it unit-testable (a spec requirement). No
behavioral divergence. main.py is the only file shown modified in git
(`M migration/python/bridge/main.py`), consistent with Step 28/29 atomic merge.

## (2) Acceptance-criteria checklist

- [PASS] Provisional entry (`context_msg_id="pending"`,
  `message_id="local-send-<rid>"`) becomes the real 6-digit id after an
  `action_ack` for that `requestId`.
  - `_hydrate_provisional_context_id_from_ack` (processing.py) matches the
    assistant entry by `local-send-<rid>` and sets `context_msg_id`. Gated on
    `pending_send_request_chat.pop(request_id)` being present.
  - Covered by `test_send_ack_hydrates_provisional_context_id` and the negative
    `test_send_ack_without_matching_pending_is_noop`.
- [PASS] A sub-agent attachment `action_ack` stores the file path in
  `media_paths_by_chat` under the real `contextMsgId`.
  - `pending_subagent_attachments.pop(request_id)` → `_extract_all_send_ack_entries`
    → 1:1 index match → `media_paths_by_chat[chat][ctx_id] = [{**file_info,
    "received_at": ...}]`. Also hydrates the provisional entry.
  - Covered by `test_subagent_attachment_ack_stores_media_path`.
- [PASS] A `run_command` `action_ack` (`ok=true`) appends
  `"Command <name> executed successfully"`; `ok=false` appends the failure line.
  - `pending_run_command_chat.pop(rid)`; canonical name from `result.command`
    else inferred from command text; success/failure text identical to original.
  - Covered by `test_run_command_ack_ok_appends_success_line`,
    `test_run_command_ack_failure_appends_failure_line`,
    `test_run_command_ack_infers_command_name_when_result_missing`.
- [PASS] End-to-end: provisional send entry hydrates to a real `contextMsgId`
  after round trip. The gateway send helpers (`messaging/gateway.py`) keep the
  bridge's own `requestId` on the wire (via `ws._transport.send`, not the SDK
  high-level methods), so the re-emitted `action_ack` event matches the pending
  maps. The SDK re-emits `action_ack` unconditionally (both ok and ok=false —
  verified in `socket.py::_route_frame`), so failed `run_command` acks still
  produce the failure line.
- [PASS] Files to create: None — correct.
- [PASS] Files to delete: None — correct (old loop removed by Step 28).

## (3) Issues list

None (BLOCKER/MAJOR). Minor observations only:

- [MINOR] session.py / ack_handler.py - Spec prose says the handler is added in
  `main.py`; actual location is `session.py` (handler) + `ack_handler.py`
  (logic) due to the Step 32/33 refactor. Behavior is identical; this is an
  expected, spec-permitted relocation, not a defect.
- [MINOR] session.py `@ws.on("send_ack")` is debug-log only. This correctly
  mirrors the original loop, where the `{"send_ack","action_ack"}` branch gated
  ALL hydration on `event_type == "action_ack"` and `send_ack` was a pure
  `logger.debug` no-op. Not a bug.

## (4) Must NOT do / isolation / contract concerns

- [OK] Wire ack shapes unchanged. SDK re-emits the `AckResult` as-is; the bridge
  rebuilds the legacy payload dict from `ack.request_id/action/ok/detail/
  result/code`. `AckResult` fields (protocol.py:198-205) match exactly.
- [OK] Dedup / echo-merge logic untouched. `_is_duplicate_reply` and
  `_merge_fromme_echo_into_provisional` are unchanged by this step.
- [OK] Does not land separately from Step 28 (handler region created there;
  same `session.py` module; only `main.py` shows as modified in git).
- [OK] Per-account isolation: `per_chat`, `per_chat_lock`,
  `pending_send_request_chat`, `pending_subagent_attachments`,
  `pending_run_command_chat`, `media_paths_by_chat` are all per-`AgentSession`
  instance attributes bound into the handler closure — no cross-tenant shared
  mutable state. (The only process-global shared state is the request-id counter
  in correlation.py, which is intentional per CONTRACT §3.)
- [OK] No race: the ack handler acquires the same `per_chat_lock` held by
  `process_message_batch` during the send+provisional-append, so hydration
  always observes the appended provisional entry. The pending maps are populated
  synchronously after the send `await` returns (no interleaving await before the
  map write), so an ack racing back cannot be processed before its pending entry
  exists.
- [OK] No future leak: gateway helpers do not register `PendingAcks` futures, so
  `resolve`/`reject` on the bridge `requestId` are graceful no-ops; the SDK does
  not allocate ack-wait timers for these sends.

## Checks performed
- Read spec, AGENTS.md/README.md protocol sections, CONTRACT §4/§1.3/§6 ground
  truth (AckResult shape).
- Read `ack_handler.py`, `session.py` (handler wiring + state init),
  `processing.py` (hydration helpers), `socket.py` (action_ack/send_ack router),
  `correlation.py` (PendingAcks), `gateway.py` (send path), `protocol.py`
  (AckResult), `main.py`, and `tests/test_hydration.py`.
- Diffed migrated `ack_handler.py` against the original
  `python/bridge/main.py` ack block (lines 2748-2889) — byte-for-byte identical
  logic.
- `py_compile` on `ack_handler.py` and `test_hydration.py` → COMPILE_OK.
- Verified `conftest.py` adds `migration/python` to sys.path so test imports
  resolve, and that `ack_handler` import chain avoids PIL/langchain (lightweight).
- Did NOT run the test suite (per strict rules); judged from static analysis.
