# Step 19 — `actionDispatcher.ts`

## Context
Move the action router (`dispatchCommand` + ack/error emitters) out of
`index.ts` and parameterize it by `AccountEntry`, so an inbound action frame is
executed against the correct account's Baileys socket and context, and the
`action_ack`/`send_ack`/`error` go back to that account's client.

## Contract references
- **CONTRACT.md §1.2** — every action type and which awaits an ack.
- **CONTRACT.md §1.3** — `action_ack`/`send_ack`/`error` shapes + `ActionResult`.
- **CONTRACT.md §2** — `ErrorCode` mapping (`deriveKickFailure`, `actionErrorCode`).

## Files to read before starting
- `src/index.ts` (`dispatchCommand`, `emitActionAck`, `emitActionError`,
  `deriveKickFailure`, `actionErrorCode`, `actionErrorDetail`)
- `src/server/accountRegistry.ts`, `src/account/accountContext.ts`
- `src/protocol/types.ts`

## Files to create
### `src/account/actionDispatcher.ts`
**Purpose:** `dispatchAction(entry: AccountEntry, frame: InboundActionFrame): Promise<void>`.
**Exports:** `dispatchAction`, `emitActionAck`, `emitActionError`.
**Must NOT contain:** WS server/listener code (Step 20), control-event emission
(Step 21), Baileys socket creation (Step 17).
**Key logic:** identical routing to today's `dispatchCommand` but using
`entry.sock`/`entry.ctx` and the account's `withJidQueue`, and sending acks via
`registry.sendToClient(entry.folderPath, …)`. Preserve every action's result
shape (CONTRACT.md §1.3) and the kick-failure code derivation (CONTRACT.md §2).
`mark_read`/`send_presence` emit **no** ack (CONTRACT.md §1.2).

## Files to modify
None yet — `index.ts` keeps its own `dispatchCommand` copy on the live client
path until the flip (Step 28). (This step adds the server-side dispatcher
alongside it.)

## Files to delete
None yet (the `index.ts` copy is removed in Step 28).

## Acceptance criteria
- `pnpm typecheck` passes with zero errors.
- `tests/node/action-dispatcher.test.ts` (mock sock + registry):
  - a `send_message` frame for account A routes to A's sock and emits
    `action_ack` (ok, `result.sent`) **and** `send_ack` to A's client.
  - a `kick_member` failure emits `action_ack` `ok:false` with the
    priority-ordered CONTRACT.md §2 `code` and a matching `error` frame.
  - `mark_read` emits **no** ack.
- `node --test` green.

## Must NOT do
- Do not remove `dispatchCommand` from `index.ts` yet.
- Do not change any action result shape or error code.
- Do not start the WS server.

## Depends on
Step 16, Step 17.
