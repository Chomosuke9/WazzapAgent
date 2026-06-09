# Step 22 — `wasocket/errors.py`

## Context
First file of the pure Python SDK. Defines the exception hierarchy that the SDK
raises when an action fails (an `error` frame, an `action_ack` with `ok=false`,
or an ack-wait timeout). Leaf module with no SDK dependencies.

## Contract references
- **CONTRACT.md §2** — the stable `ErrorCode` set and what each maps to.
- **CONTRACT.md §4** — the methods document which subclass each action raises.

## Files to read before starting
- Original - CONTRACT.md §2, §4
- `migration/node/index.ts` `actionErrorCode`/`actionErrorDetail` (Node side that produces
  these codes) — for parity

## Files to create
### `migration/python/wasocket/errors.py`
**Purpose:** `WaSocketError` hierarchy + code→class mapping.
**Exports:**
- `class WaSocketError(Exception)` — base; carries `code`, `detail`, `request_id`,
  `action`.
- `NotFoundError`, `NotGroupError`, `PermissionDeniedError`,
  `InvalidTargetError`, `SendFailedError`, `TimeoutError` (each maps to a
  CONTRACT.md §2 code).
- `from_error_frame(payload: dict) -> WaSocketError` — builds the right subclass
  from an `error` frame payload (CONTRACT.md §1.3).
- `from_failed_ack(payload: dict) -> WaSocketError` — builds from an
  `action_ack` with `ok=false` (uses its `code`/`detail`).
- A `CODE_TO_CLASS` mapping table.
**Must NOT contain:** any WS/transport/asyncio code; any frame encoding.
**Key logic:** unknown/missing `code` → base `WaSocketError`. The string codes
must exactly equal CONTRACT.md §2 values.

## Files to modify
None.

## Files to delete
None.

## Acceptance criteria
- `python -c "import python.wasocket.errors"` imports cleanly.
- `pytest migration/python/tests/test_errors.py`:
  - each of the 6 codes round-trips through `from_error_frame` to the correct
    subclass; `from_error_frame({"code":"weird"})` → base `WaSocketError`.
  - `from_failed_ack({"ok":False,"code":"not_found",...})` → `NotFoundError`.
  - every subclass `is` a `WaSocketError`.

## Must NOT do
- Do not import `websockets`/`asyncio` here.
- Do not define dataclasses for frames (Step 23).
- Do not wire into the bridge.

## Depends on
None.
