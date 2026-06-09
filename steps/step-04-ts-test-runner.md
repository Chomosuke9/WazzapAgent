# Step 04 — TS test runner + ambient declarations

## Context
Phase 2 introduces `*.test.ts` and typed source. The test command must run both
the existing `tests/node/**/*.test.mjs` and new `.ts` tests, and any dependency
missing types must be declared so `pnpm typecheck` stays clean.

## Contract references
- None.

## Files to read before starting
- `package.json` (`test` script)
- `tests/node/` (existing test layout)
- `node_modules/.../package.json` `types` fields for `baileys`,
  `better-sqlite3`, `fs-extra`, `pino`, `sharp`, `fluent-ffmpeg` (to find gaps)

## Files to create
### `src/types/ambient.d.ts` (only if gaps exist)
**Purpose:** Ambient module declarations for dependencies lacking bundled types.
**Exports:** `declare module "<dep>"` stubs for the gaps found above only.
**Must NOT contain:** declarations for deps that already ship types; any
project type that belongs in `src/protocol/types.ts` (CONTRACT.md §5).
**Key logic:** Minimal `declare module` shims; prefer installing an `@types/*`
package where one exists rather than hand-writing a stub.

## Files to modify
### `package.json`
**Change:** Make `test` run TS+mjs tests (e.g. `node --test --import tsx 'tests/**/*.test.{mjs,ts}'`,
or add `vitest` if lower-friction). Keep `tests/node/**/*.test.mjs` discovered.
Add any `@types/*` dev deps found necessary.
**Location:** `scripts.test`, `devDependencies`.

## Files to create (test)
### `tests/node/smoke.test.ts`
**Purpose:** Prove the TS test path works.
**Exports:** n/a (a trivial `assert.equal(1,1)` test).
**Key logic:** one `node:test` `test()` that imports a `.ts` helper to confirm
the loader resolves TypeScript.

## Acceptance criteria
- `pnpm test` runs and **all** existing `tests/node/**/*.test.mjs` pass.
- The new `tests/node/smoke.test.ts` is discovered and passes.
- `pnpm typecheck` reports zero errors (no missing-type errors from deps).

## Must NOT do
- Do not convert production `.js` source in this step.
- Do not add ambient declarations for deps that already provide types.

## Depends on
Step 03.
