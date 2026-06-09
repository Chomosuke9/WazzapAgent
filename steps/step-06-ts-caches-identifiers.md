# Step 06 — TypeScript: `caches`, `identifiers`

## Context
`caches.js` holds the module-level `Map`/`Set` state; `identifiers.js` reads it
to manage contextMsgId allocation and the senderRef registry. Convert both to
TypeScript with full types. **Type-only** — the module-singleton design is left
intact here; the per-account refactor is Step 16.

## Contract references
- None on the wire. The contextMsgId concept underlies CONTRACT.md §7
  (`contextMsgId`) but no shape changes here.

## Files to read before starting
- `src/caches.js`
- `src/identifiers.js`

## Files to create
None beyond renames.

## Files to modify
### `src/caches.js` → `src/caches.ts`
**Change:** Rename; type each `Map`/`Set` (key/value generics) and
`cacheSetBounded<K,V>`. Keep the exported singletons and `GROUP_JOIN_STUB_TYPES`
filter exactly as-is.
**Location:** whole file.

### `src/identifiers.js` → `src/identifiers.ts`
**Change:** Rename; type `normalizeJid`, `normalizeContextMsgId`,
`nextContextMsgId`, `rememberSenderRef`, `rememberMessage`,
`resolveQuotedMessage`, `rememberMessageKeyIndex`, and the registry entry
shapes. Behavior unchanged.
**Location:** whole file.

## Files to delete
- `src/caches.js`, `src/identifiers.js`.

## Acceptance criteria
- `pnpm typecheck` passes with zero errors.
- `pnpm dev` boots; an inbound message still gets a contextMsgId (no runtime
  error from identifier calls).
- `node --test 'tests/node/**/*.test.mjs'` passes (including any existing
  identifier tests).

## Must NOT do
- Do not change the module-singleton design (no `AccountContext` yet — Step 16).
- Do not change the senderRef derivation or contextMsgId wrap behavior.
- Do not convert any other file.

## Depends on
Step 05.
