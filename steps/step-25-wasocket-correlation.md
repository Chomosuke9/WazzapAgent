# Step 25 — `wasocket/correlation.py`

## Context
The SDK awaits each action's ack by `request_id`. This module generates the
`request_id` (in the exact legacy format) and manages the pending-future map
that `socket.py` resolves when an `action_ack`/`error` arrives.

## Contract references
- **CONTRACT.md §3** — `request_id` format `"<tag>-<unix_ms>-<seq6>"`,
  process-global monotonic counter, 30s default expiry.
- **CONTRACT.md §2** — a pending future is rejected with a `timeout`
  `WaSocketError` on expiry.

## Files to read before starting
- CONTRACT.md §2, §3
- `python/bridge/messaging/processing.py` (`_make_request_id`, `REQUEST_COUNTER`)
  — the exact format to port
- `python/wasocket/errors.py` (Step 22)

## Files to create
### `python/wasocket/correlation.py`
**Purpose:** `request_id` generation + pending-ack futures.
**Exports:**
- `make_request_id(tag: str) -> str` — `f"{tag}-{int(time.time()*1000)}-{next(_counter):06d}"`
  with a module-global `itertools.count(1)` counter (shared across all sockets in
  the process, per §3).
- `class PendingAcks` with:
  - `register(request_id: str, *, timeout: float = 30.0) -> asyncio.Future`
  - `resolve(request_id: str, result: dict) -> None`
  - `reject(request_id: str, error: WaSocketError) -> None`
  - `reject_all(error: WaSocketError) -> None` (used on disconnect)
**Must NOT contain:** any WS/socket code; any frame encoding; event dispatch.
**Key logic:** on `register`, schedule a timeout that rejects the future with a
`TimeoutError` (`code="timeout"`) and removes it. `resolve`/`reject` on an
unknown/expired `request_id` are no-ops (a late ack is ignored, per §3). Cancel
the timeout when resolved/rejected.

## Files to modify
None (the bridge keeps its own `_make_request_id` until Step 28).

## Files to delete
None.

## Acceptance criteria
- `pytest python/tests/test_correlation.py`:
  - `make_request_id("send")` matches regex `^send-\d{13}-\d{6}$`; two calls give
    strictly increasing `seq6`.
  - `register` then `resolve` resolves the future with the result dict.
  - `register(timeout=0.05)` with no resolve → future raises `TimeoutError`
    (CONTRACT §2 `code=="timeout"`).
  - `resolve` on an unknown/expired id is a no-op (no exception).
  - `reject_all` rejects all outstanding futures.
- `python -c "import python.wasocket.correlation"` imports cleanly.

## Must NOT do
- Do not change the `request_id` format from CONTRACT.md §3.
- Do not import `websockets` or open sockets.
- Do not modify `processing.py` yet.

## Depends on
Step 22.
