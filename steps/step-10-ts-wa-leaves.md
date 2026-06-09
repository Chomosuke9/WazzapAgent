# Step 10 — TypeScript: `wa/` leaves (`utils`, `sendQueue`, `interactive/*`)

## Context
Convert the `wa/` modules that are leaves relative to the rest of `wa/`: the
concurrency helpers, the per-JID send queue, and the interactive-message
builders. Type-only; `withJidQueue`'s signature is preserved (per-account keying
is Step 16).

## Contract references
- `interactive/*` build the Baileys messages behind `send_quiz`, `send_buttons`,
  `send_carousel`, `send_copy_code` (CONTRACT.md §1.2). No wire change.

## Files to read before starting
- Original - `migration/node/wa/utils.js`
- `migration/node/wa/sendQueue.js`
- `migration/node/wa/interactive/{index.js,sendInteractive.js,sendButtons.js,sendCarousel.js}`

## Files to create
None beyond renames.

## Files to modify
### `migration/node/wa/utils.js` → `migration/node/wa/utils.ts`
**Change:** Type `withTimeout`, `runWithConcurrency`, `escapeRegex`, semaphore.

### `migration/node/wa/sendQueue.js` → `migration/node/wa/sendQueue.ts`
**Change:** Type `withJidQueue<T>(jid: string, fn: () => Promise<T>): Promise<T>`.
Keep the module-level `jidQueues` map and behavior unchanged.

### `migration/node/wa/interactive/*.js` → `*.ts`
**Change:** Type `sendQuickReply`, `sendUrlButtons`, `sendCopyCode`,
`sendCombinedButtons`, `sendList`, `sendNativeFlow`, `sendRichMessage`,
`sendLegacyButtons`, `sendTemplate`, `sendCarousel`; convert the barrel
`index.ts`. Logic unchanged.

## Files to delete
- The `.js` originals listed above.

## Acceptance criteria
- `pnpm typecheck` passes with zero errors.
- `pnpm dev` boots; a `send_quiz` action still renders (manual check) or at least
  reaches `sendQuickReply` without a type/runtime error.
- `node --test 'tests/node/**/*.test.mjs'` passes.

## Must NOT do
- Do not change `withJidQueue` to key by `(folderPath, jid)` (Step 16).
- Do not change interactive proto/`additionalNodes` construction.
- Do not convert `outbound`/`actions`/`connection` here (Steps 12–13).

## Depends on
Step 05, Step 09.
