# Step 13 — TypeScript: orchestrators (`wa/commandHandler`, `wa/connection`, `wa/index`)

## Context
Convert the orchestration layer: the slash-command dispatch switch, the Baileys
socket lifecycle (`startWhatsApp` + button/form handlers + the two
`messages.upsert` listeners), and the `wa/` barrel. Logic unchanged; still a
single global `sock` (multi-account is Phase 3).

## Contract references
- None changed. `connection.ts` still emits `whatsapp_status` with the legacy
  `"open"/"closed"` values (normalization to CONTRACT.md `WaStatus` happens in
  Step 18/20).

## Files to read before starting
- `src/wa/commandHandler.js`
- `src/wa/connection.js`
- `src/wa/index.js`

## Files to create
None beyond renames.

## Files to modify
### `src/wa/commandHandler.js` → `commandHandler.ts`
**Change:** Type `handleCommandListener(msg, context)` and the `context` object
shape and the command `switch`. Behavior unchanged.

### `src/wa/connection.js` → `connection.ts`
**Change:** Type `startWhatsApp`, `getSock`, the button/form handlers
(`handleButtonResponse`, `parseModelReply`, model form helpers). Keep the single
`let sock` module global for now.

### `src/wa/index.js` → `index.ts`
**Change:** Convert the barrel re-exports.

## Files to delete
- The three `.js` originals.

## Acceptance criteria
- `pnpm typecheck` passes with zero errors.
- `pnpm dev` performs QR pairing and an inbound/outbound round trip without
  type/runtime error.
- `node --test 'tests/node/**/*.test.mjs'` passes.

## Must NOT do
- Do not remove the global `sock`/`getSock()` (Step 16/17).
- Do not move the two `messages.upsert` listeners into `eventForwarder` (Step 18).
- Do not change command/button behavior.

## Depends on
Step 12.
