# Step 31 — Trim Python server dependency surface

## Context
After the flip, `main.py` no longer runs `websockets.serve`; the only remaining
use of the `websockets` library is the SDK transport **client** (Step 26).
Remove the dead server-only helpers and confirm the dependency is still required
for the client.

## Contract references
- None changed.

## Files to read before starting
- `python/bridge/main.py` (`_parse_endpoint`, legacy `_shutdown_signal_handler`,
  any `websockets.serve` import path)
- `python/wasocket/transport.py` (confirms the client still imports `websockets`)
- `requirements.txt`

## Files to create
None.

## Files to modify
### `python/bridge/main.py`
**Change:** Delete `_parse_endpoint`, the legacy `_shutdown_signal_handler` (if
unused), and any remaining `websockets.serve`/server-only import left after
Step 28. Keep the signal handling that the WaSocket boot uses.
**Location:** module-level helpers near `main()`.

### `requirements.txt`
**Change:** Verify only — `websockets` stays (used by `wasocket/transport.py`).
Remove any dependency that was only used by the deleted server path (expected:
none).

## Files to delete
None (only dead functions inside `main.py`).

## Acceptance criteria
- `grep -n "websockets.serve\|_parse_endpoint" python/bridge/main.py` returns
  **zero** matches.
- `python -m pyflakes python/bridge/main.py` (if available) reports no unused
  imports; otherwise `python -c "import ast,sys; ast.parse(open('python/bridge/main.py').read())"`
  succeeds and `python -m python.bridge.main` boots and connects as a client.
- `pytest python/tests/` green.

## Must NOT do
- Do not remove `websockets` from `requirements.txt` (the SDK client needs it).
- Do not change agent logic or the WaSocket wiring from Step 28.

## Depends on
Step 28.
