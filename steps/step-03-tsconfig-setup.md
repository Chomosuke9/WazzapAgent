# Step 03 — TypeScript toolchain + `tsconfig.json`

## Context
Phase 2 converts `migration/node/*.js` to TypeScript one file at a time. For that to be
possible without breaking `pnpm dev`, `.ts` and `.js` must coexist and both run.
This step adds the TS toolchain, a `tsconfig.json` with `allowJs`, and runner
scripts so the existing JS entrypoint still boots while individual files become
`.ts`.

## Contract references
- None directly. Establishes the build that later compiles `migration/node/protocol/types.ts`
  (CONTRACT.md §5) and the rest of the TS code.

## Files to read before starting
- Original - `package.json`
- `scripts/patch-baileys.js` (referenced by `postinstall`)
- `migration/node/index.js` (current entrypoint)

## Files to create
### `tsconfig.json`
**Purpose:** Project TypeScript configuration enabling JS/TS coexistence.
**Exports:** n/a (config).
**Must NOT contain:** any `paths` aliasing that changes module resolution
semantics; emit settings that overwrite `migration/node/` in place.
**Key logic:** `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`,
`"target": "ES2022"`, `"allowJs": true`, `"checkJs": false`, `"strict": true`,
`"esModuleInterop": true`, `"resolveJsonModule": true`, `"noEmit": true` (a
separate `dist` build config may be added later), `"skipLibCheck": true`.
Keep ESM (`package.json` `"type": "module"` unchanged).

## Files to modify
### `package.json`
**Change:** Add dev dependencies `typescript`, `tsx`, `@types/node`, `@types/ws`
(pin exact versions). Change `dev`/`start` to run the entry through `tsx`
(so a `.ts` entry and `.js` imports both load). Add `"typecheck": "tsc --noEmit"`.
Leave `postinstall`, `test`, `stress:db` as-is.
**Location:** `scripts` and `devDependencies`.

## Files to delete
None.

## Acceptance criteria
- `pnpm install` completes without error.
- `pnpm typecheck` runs and reports **zero** errors (JS files are not type-checked
  because `checkJs:false`).
- `pnpm dev` still boots the gateway from the existing `migration/node/index.js` (reaches
  "connecting to LLM websocket"/QR without a module error).
- `node --test 'tests/node/**/*.test.mjs'` still passes.
- `tsconfig.json` exists at repo root and is valid JSON parseable by `tsc`.

## Must NOT do
- Do not convert any `.js` file to `.ts` in this step.
- Do not enable `checkJs`.
- Do not change `"type": "module"` or the baileys patch.

## Depends on
None.
