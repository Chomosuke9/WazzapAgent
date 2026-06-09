# Step 26 — `wasocket/transport.py` (ports `wsClient.js` reconnect/backoff)

## Context
The transport is the WS **client** layer: connect, exponential backoff with
symmetric jitter, the canonical `isAlive` heartbeat, the accept-then-kick grace
timer, a bounded reliable queue, the `hello`/`hello_ack` handshake, and graceful
close. **This is the step that ports `migration/node/wsClient.js`'s reconnect/backoff logic
into Python.** It emits raw decoded frames to a callback; it does not interpret
them.

## Contract references
- **CONTRACT.md §1.1** — `hello`/`hello_ack` handshake on every (re)connect.
- **CONTRACT.md §1.6** — reliable queue covers reliable frames (here: the SDK's
  reliable sends, primarily `hello`).
- **CONTRACT.md §3** — does not generate `request_id` (that is Step 25); just
  ships frames.

## Files to read before starting
- Original - `migration/node/wsClient.js` (entire file: `computeReconnectDelay`,
  `connect`/`scheduleReconnect`/`_startHeartbeat`/`_clearHeartbeat`/`close`/
  `send`/`sendReliable`/`flushReliableQueue`, the `stableResetTimer` grace logic)
- `migration/python/wasocket/protocol.py` (Step 23), `migration/python/wasocket/errors.py` (Step 22)
- `migration/python/bridge/main.py` `main()` (`websockets` server config: `ping_interval=20,
  ping_timeout=20`) — for symmetry

## Files to create
### `migration/python/wasocket/transport.py`
**Purpose:** `WSClientTransport` — the resilient WS client.
**Exports:**
- `compute_reconnect_delay(attempt, base_ms, max_ms, jitter_ratio, rand=random.random) -> int`
  — exact port of `computeReconnectDelay` (same formula, clamp to `max_ms`).
- `class WSClientTransport` with:
  - `async connect(node_url, hello_frame, on_frame, on_status)` — opens the
    socket, sends `hello`, awaits `hello_ack`, then pumps frames to `on_frame`.
  - `send(frame)` (best-effort) / `send_reliable(frame)` (queue if not OPEN,
    bound 1000, drop oldest) / `flush_reliable()`.
  - reconnect with `compute_reconnect_delay`, the OPEN-grace period before
    resetting `attempt`, and the `isAlive` heartbeat (ping cadence
    `WS_HEARTBEAT_INTERVAL_MS`-equivalent; terminate-on-missed-pong).
  - `async close()` — flush-if-open, stop timers, close.
**Must NOT contain:** action methods, `request_id` generation, event dispatch /
`on()` decorator (Step 27); any agent logic.
**Key logic:** mirror `wsClient.js` semantics 1:1 — backoff growth survives
accept-then-kick because `attempt` only resets after the OPEN grace window.

## Files to modify
None (Node `wsClient.ts` is deleted later, Step 30).

## Acceptance criteria
- `pytest migration/python/tests/test_transport.py`:
  - `compute_reconnect_delay` matches the JS reference for a table of
    `(attempt, base, max, jitter, rand)` inputs (port the existing
    `computeReconnectDelay` test cases; injectable `rand`).
  - against a fake server: `connect` sends `hello` and resolves after
    `hello_ack`; frames are delivered to `on_frame`.
  - accept-then-immediate-close: `attempt` keeps growing (delay increases) — the
    grace timer did not reset it.
  - `send_reliable` while disconnected queues; on reconnect the queue flushes in
    order; > 1000 drops oldest.
- `python -c "import python.wasocket.transport"` imports cleanly.

## Must NOT do
- Do not interpret frames or build the public `WaSocket` API (Step 27).
- Do not generate `request_id`s.
- Do not change the backoff formula or heartbeat semantics from `wsClient.js`.

## Depends on
Step 23, Step 25.
