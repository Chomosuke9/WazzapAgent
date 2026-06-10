# Step 26 Verification — `wasocket/transport.py` (port of wsClient reconnect/backoff)

## (1) Verdict: ACCURATE

The implementation faithfully ports `src/wsClient.js`'s reconnect/backoff/heartbeat/grace
logic into `migration/python/wasocket/transport.py`, exposes exactly the required
surface, and respects every "Must NOT do" constraint. A few minor robustness/version
notes are listed but none are spec violations.

> Note on the reference path: the spec cites `migration/node/wsClient.js`/`.ts`, but
> no `wsClient` file exists under `migration/node/` (confirmed via glob). The only
> reference is the original `src/wsClient.js` (READ-ONLY). The spec's "Files to modify:
> None (Node wsClient.ts deleted later, Step 30)" is consistent with this — there is
> nothing to modify for Step 26. The Python port was verified 1:1 against `src/wsClient.js`.

## (2) Acceptance-criteria checklist

- PASS — `compute_reconnect_delay(attempt, base_ms, max_ms, jitter_ratio, rand=random.random) -> int`
  is an exact port of `computeReconnectDelay`. Formula matches line-for-line; `_js_round`
  = `floor(x+0.5)` correctly mirrors JS `Math.round` (Python's `round` uses banker's
  rounding and would diverge on `.5`). Non-finite/`attempt<1` → 0. Final clamp to `max_ms`. ✓
- PASS — Test table (`test_transport.py`) ports the JS `computeReconnectDelay` cases and
  cross-checks against an independent JS oracle (`_js_reference`) over a (attempt, base,
  max, jitter, rand) grid; injectable `rand`. Matches spec requirement.
- PASS — `connect()` sends `hello` (`conn.send(_encode(hello_frame))`), awaits one
  `recv()`, requires `type == "hello_ack"`, then resolves the `_ready_event`; subsequent
  frames are decoded and forwarded to `on_frame`. The handshake `recv` consumes only the
  ack; the `async for raw in conn` pump reads later frames with no frame loss. Verified by
  `test_connect_handshake_and_frame_delivery`.
- PASS — Accept-then-immediate-close: handshake never completes → `opened` stays False →
  `_arm_stable_reset` is never called → `attempt` keeps incrementing in `_supervise`
  (`self.attempt += 1` per loop). The OPEN-grace floor is `max(base, 5000)` ms, never
  reached in the flap, so `attempt` is not reset. Verified by
  `test_accept_then_close_keeps_growing_attempt`.
- PASS — `send_reliable` queues via `collections.deque(maxlen=1000)` when not OPEN
  (drop-oldest, equivalent to wsClient push-then-shift); `flush_reliable` drains in FIFO
  order on (re)connect; >1000 drops the oldest (n=0). Verified by
  `test_send_reliable_drops_oldest_over_1000` and
  `test_send_reliable_queues_and_flushes_in_order_on_reconnect`.
- PASS (with note) — `python -c "import python.wasocket.transport"` clean import: file
  passes `py_compile`. Could not execute the runtime import because `websockets` is not
  installed in this verification sandbox; the real import path used by the test suite is
  `wasocket.transport` (with `migration/python` on `sys.path`). The literal
  `python.wasocket.transport` dotted path does not correspond to the migration layout
  (that would resolve to the pre-migration `/python/` tree); treated as loose spec wording.

### Required surface (all present)
- `compute_reconnect_delay(...)` ✓ ; `class WSClientTransport` ✓
- `async connect(node_url, hello_frame, on_frame, on_status)` ✓ (on_status optional)
- `send` (best-effort, drop if not OPEN) ✓ ; `send_reliable` (queue, bound 1000, drop-oldest) ✓ ; `flush_reliable` ✓
- reconnect via `compute_reconnect_delay` ✓ ; OPEN-grace `attempt` reset (`_arm_stable_reset`, floor 5000ms) ✓ ; `isAlive` heartbeat (`_heartbeat_loop`, check-then-ping, terminate-on-missed-pong) ✓
- `async close()` — flush-if-open, cancel supervisor/heartbeat/grace timers, bounded socket close, idempotent ✓

## (3) Issues

- [MINOR] `migration/python/wasocket/transport.py:312` — handshake `raw = await conn.recv()`
  has no read timeout (lib keepalive is disabled with `ping_interval=None`). A server that
  accepts the TCP/WS connection but never sends `hello_ack` and never closes would block the
  pump indefinitely, and `connect()` (awaiting `_ready_event`) would never resolve. `close()`
  still cancels it cleanly, so it is not a permanent leak. `wsClient.js` does not await the ack
  at all (fire-and-forget), so this is a behavioral divergence with a hang risk against a
  misbehaving/silent server. Recommend wrapping the handshake `recv` in `asyncio.wait_for`.
- [MINOR] `migration/python/wasocket/transport.py:39` — uses `websockets.asyncio.client`
  (and tests use `websockets.asyncio.server`), the new asyncio API introduced in
  `websockets` 13.0, but `requirements.txt` pins `websockets>=12.0`. On a clean install
  resolving to 12.x the import would fail. Not unique to this step (socket.py/tests share
  it), but the floor should be `>=13` (ideally `>=15`). Latent, env-dependent.
- [MINOR] `migration/python/wasocket/transport.py` — `connect()` blocks the caller until
  the FIRST successful handshake (or `close()`), whereas `wsClient.connect()` returns
  immediately and reconnects in the background. This is documented in the docstring and is
  an intentional design choice; downstream (Step 27/28) must launch it as a task if it
  wants non-blocking boot while the server is down. Noted for awareness, not a defect.

## (4) Must-NOT-do / isolation / contract notes

- "No action methods / no `request_id` generation / no `on()` decorator / no agent logic":
  SATISFIED. The module only opens the socket, performs the `hello`/`hello_ack` handshake,
  and pumps raw decoded `(type, parsed)` frames to `on_frame`. It does not interpret frames
  or build any public WaSocket API. No `request_id` is generated.
- "Do not change the backoff formula or heartbeat semantics": SATISFIED. Formula is
  identical (incl. `Math.round`-faithful `_js_round` and double clamp to `max_ms`).
  Heartbeat is the canonical isAlive check-then-ping with one-interval detection latency;
  the only mechanical difference is `conn.close(1011)` instead of `ws.terminate()` (no
  terminate equivalent in `websockets`), which still triggers the normal reconnect path —
  documented in the code.
- CONTRACT.md §1.1 handshake: sends `hello`, requires `hello_ack` before declaring ready. ✓
- CONTRACT.md §1.6 reliability: `send` is best-effort (dropped if not OPEN); `send_reliable`
  is queued and flushed on reconnect (bounded 1000, drop-oldest). ✓
- Per-tenant isolation: `WSClientTransport` holds only instance state; the sole class-level
  data are immutable constants (`MAX_RELIABLE_QUEUE`, `STABLE_RESET_FLOOR_MS`). No shared
  mutable module/class state across tenants — no isolation leak. ✓
- Teardown: `close()` cancels the supervisor task and awaits it, cancels heartbeat and
  grace timers (`_clear_heartbeat` / `_clear_stable_reset`), bounds the socket close with
  `asyncio.wait_for(..., 1.0)`, and is idempotent (`_closed` flag). No leaked tasks/timers. ✓
