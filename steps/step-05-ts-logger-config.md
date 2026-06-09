# Step 05 — TypeScript: `logger`, `config`

## Context
First Phase-2 conversion. `logger` and `config` are imported by nearly every
module, so typing them first propagates types outward and lets later steps rely
on a typed `config` object. Type-only change; runtime identical.

## Contract references
- None (no wire shapes). `config` will later gain `wsListenPort`/per-tenant
  fields in Phase 3/6; **not** in this step.

## Files to read before starting
- `src/logger.js`
- `src/config.js`
- `tsconfig.json`

## Files to create
None new beyond the renamed files below.

## Files to modify
### `src/logger.js` → `src/logger.ts`
**Change:** Rename to `.ts`; type the exported pino logger. Update the single
`export default` to a typed value. Logic unchanged.
**Location:** whole file (small).

### `src/config.js` → `src/config.ts`
**Change:** Rename to `.ts`; define a `Config` interface for the exported object
and annotate the env-parse helpers (`positiveInt`, `nonNegativeInt`,
`parseRatio`, `parseJidList`). Keep every field and default exactly as-is.
**Location:** whole file.

## Files to delete
- `src/logger.js`, `src/config.js` (replaced in place by `.ts`).

## Acceptance criteria
- `pnpm typecheck` passes with zero errors.
- `pnpm dev` boots the gateway (reaches QR/WS connect) with no module-resolution
  error for `./logger.js`/`./config.js` importers.
- `node --test 'tests/node/**/*.test.mjs'` passes.
- `git ls-files src/logger.* src/config.*` lists only the `.ts` files.

## Must NOT do
- Do not change any config field name, default, or env var.
- Do not convert any other file.
- Do not add `wsListenPort` or per-tenant config (later phases).

## Depends on
Step 03.
