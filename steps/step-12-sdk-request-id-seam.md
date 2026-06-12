# Step 12 — SDK `request_id` seam; remove `gateway.py` `_transport` bypass
**Phase:** 4 · **Risk:** med · **Depends on:** step-11

## Goal
Give the WaSocket SDK a public way to send an action with a caller-supplied
`request_id`, then delete the bridge's reach into the SDK's private
`ws._transport`. Unify the two duplicate requestId counters.

## Why (audit — Medium #6)
`gateway.py:36` does `await ws._transport.send(frame)` and hand-builds JSON in
every `send_*` to preserve the bridge's own requestId (resolved in
`ack_handler.py`). This is a private-attribute coupling with no compile-time
safety (also leaked into `test_subagent_output.py:520`), bypasses the SDK's
`PendingAcks`/timeout net, and implements the wire protocol twice (schema-drift
risk). There are two independent counters with identical formats
(`correlation._counter` vs `processing.REQUEST_COUNTER`) — latent collision.

## Changes
- SDK `socket.py`: action methods accept an optional `request_id` parameter
  (when provided, register it in `PendingAcks` and use it on the wire). This is
  the preferred fix — it lets the bridge keep its own id through the public API.
  Add the missing `relay_lottie_sticker` method (action type already exists).
- `gateway.py`: replace `_ws_send`/`ws._transport.send` with the public SDK
  action calls passing the bridge's `request_id`. Delete the hand-rolled
  `json.dumps` frame building.
- Remove the duplicate `processing.REQUEST_COUNTER`; use one id source.
- Update `test_subagent_output.py` to stop touching `_transport`.
- Wire (or remove) the silently-dropped SDK params `send_message(mentions=)` and
  `send_buttons(reply_to=)` — make them actually serialize or delete them.

## OOP / target
The bridge depends only on the SDK's public API; one requestId allocator; no
private-attribute coupling; the protocol is encoded in exactly one place
(`protocol.py`).

## Must NOT
- Must NOT change the wire frames or `CONTRACT.md`.
- Must NOT change the bridge's requestId→pending-map correlation semantics
  (only the transport mechanism changes).

## Verification
- Python gates green; `test_socket`, `test_correlation`, `test_hydration`,
  `test_subagent_output` pass.
- `git grep -n "_transport" python/` → only inside the SDK's own transport
  module (0 in `bridge/` and `tests/`).

## Done when
- Bridge sends via the public SDK with its own `request_id`; bypass and
  duplicate counter gone; gates green.
