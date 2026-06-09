# Step 20 — `wsServer.ts`

## Context
Build the inbound WS **server** that accepts Python `WaSocket` clients,
performs the `hello`/`hello_ack` handshake, binds each client to its account,
routes inbound action frames to the dispatcher, and routes Baileys events out via
the forwarder. Built and tested behind a secondary entry; the live boot
(`index.ts`) is **not** changed here (that is Step 28).

## Contract references
- **CONTRACT.md §1.1** — `hello` / `hello_ack` handshake.
- **CONTRACT.md §1.2–1.5** — frame routing (actions in, acks/events/control out).
- **CONTRACT.md §8** — handshake triggers `createOrResumeAccount` (which ensures
  the folder layout).

## Files to read before starting
- `src/server/accountRegistry.ts` (Step 15)
- `src/account/baileysFactory.ts` (Step 17)
- `src/account/eventForwarder.ts` (Step 18)
- `src/account/actionDispatcher.ts` (Step 19)
- `src/wsClient.ts` (`_startHeartbeat`/`_clearHeartbeat` to mirror server-side)
- `src/config.ts` (token; add `wsListenPort`)

## Files to create
### `src/server/wsServer.ts`
**Purpose:** `startWsServer(port?: number): WebSocketServer` + per-connection
lifecycle.
**Exports:** `startWsServer`.
**Must NOT contain:** Baileys socket creation logic (delegate to
`baileysFactory`), action handling logic (delegate to `actionDispatcher`), event
normalization (delegate to `eventForwarder`).
**Key logic:**
- On connection: optional `Authorization: Bearer <LLM_WS_TOKEN>` check; wait for
  the first frame; require `type === "hello"`; call
  `createOrResumeAccount({ folderPath })`; `registry.bindClient`; send
  `hello_ack { folderPath, waStatus }`; `registry.flushReliableQueue`.
- On subsequent frames: dispatch to `actionDispatcher.dispatchAction(entry, frame)`.
- On `close`: `registry.unbindClient(folderPath)` — **keep the Baileys socket
  alive** (account stays connected to WhatsApp); reliable control events queue
  until the client returns.
- Server-side heartbeat using the canonical `ws` `isAlive` ping/terminate pattern
  (mirror `wsClient` `_startHeartbeat`, interval `WS_HEARTBEAT_INTERVAL_MS`).

## Files to modify
### `src/config.ts`
**Change:** Add `wsListenPort` (env `WS_LISTEN_PORT`, default `3000`). Do not
remove `wsEndpoint` yet (old client path still uses it).

## Files to delete
None.

## Acceptance criteria
- `pnpm typecheck` passes with zero errors.
- `tests/node/ws-server.test.ts` (scripted raw `ws` client against
  `startWsServer` with a mocked `baileysFactory`):
  - connect → send `hello {folderPath, protocolVersion:"2.0"}` → receive
    `hello_ack {folderPath, waStatus}`.
  - send a `send_message` action → receive `action_ack` (+ `send_ack`).
  - missing/invalid `Authorization` (when token configured) → connection rejected.
  - disconnect with a queued reliable control event → reconnect (`hello`) →
    queued event delivered after `hello_ack`.
- `node --test` green; `pnpm dev` (old path) still works unchanged.

## Must NOT do
- Do not modify `index.ts` boot or remove the old `wsClient` path (Step 28).
- Do not tear down the Baileys socket on client disconnect.
- Do not re-implement action routing or event normalization inline.

## Depends on
Step 18, Step 19.
