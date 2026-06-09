# Step 14 — TypeScript: `wsClient.ts` and `index.ts` (finish JS→TS)

## Context
Final Phase-2 conversion. Type the WS client (still the live transport) and the
entrypoint/dispatcher. After this step the whole `migration/node/` is TypeScript and behaves
identically — Node is still a WS **client**, Python still the server. No flip yet.

## Contract references
- `dispatchCommand` routes the actions in CONTRACT.md §1.2 and emits
  `action_ack`/`send_ack`/`error` (CONTRACT.md §1.3). No shape change.
- `computeReconnectDelay` logic here is the reference ported to Python in Step 26.

## Files to read before starting
- Original - `migration/node/wsClient.js`
- `migration/node/index.js`
- `migration/node/protocol/types.ts` (Step 09)

## Files to create
None beyond renames.

## Files to modify
### `migration/node/wsClient.js` → `wsClient.ts`
**Change:** Type `LLMWebSocket` (extends `EventEmitter`), `computeReconnectDelay`,
the reliable queue, heartbeat timers, `send`/`sendReliable`/`flushReliableQueue`/
`close`. Behavior unchanged.

### `migration/node/index.js` → `index.ts`
**Change:** Type `dispatchCommand(msg: InboundFrame)`, `emitActionAck`,
`emitActionError`, `deriveKickFailure`, `bootstrap`. Use `OutboundFrame`/
`ActionAckPayload`/`WsErrorPayload` from `migration/node/protocol/types.ts`. Behavior
unchanged; still `startWhatsApp()` + `wsClient.connect()`.

## Files to delete
- `migration/node/wsClient.js`, `migration/node/index.js`.

## Acceptance criteria
- `pnpm typecheck` passes with zero errors and `allowJs` is now effectively unused
  (no `.js` remains under `migration/node/`: `git ls-files 'src/**/*.js'` is empty).
- `pnpm dev` full smoke test against the existing Python server: inbound message →
  `send_message` action → WhatsApp.
- `node --test 'tests/node/**/*.test.mjs'` passes, including the
  `computeReconnectDelay` tests.

## Must NOT do
- Do not flip the WS direction or remove `wsClient` (Steps 28/30).
- Do not move `dispatchCommand` into `actionDispatcher` (Step 19).
- Do not change reconnect/backoff/heartbeat numbers.

## Depends on
Step 13.
