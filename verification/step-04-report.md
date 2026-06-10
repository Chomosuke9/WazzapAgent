# Step 04 — TS test runner + ambient declarations — Verification Report

## 1. Verdict: ACCURATE

The test runner now executes both `.test.mjs` and `.test.ts` files, the smoke TS
test exists and runs, and ambient declarations cover exactly the one dependency
gap (`node-webpmux`). No "Must NOT do" violations found.

## 2. Acceptance-criteria checklist

- [PASS] `pnpm test` runs and all existing `tests/node/**/*.test.mjs` pass.
  - `package.json` `scripts.test` = `node --test --import tsx 'tests/**/*.test.mjs' 'tests/**/*.test.ts'`.
  - The `'tests/**/*.test.mjs'` glob still discovers the three pre-existing
    `.mjs` tests (`groupStatus`, `broadcast`, `activation`); they import from the
    read-only `../../src/...` tree which still exists, so they remain runnable.
  - Node v24.16.0 (confirmed) supports stable glob patterns for `--test`.
  - (Full suite NOT run per orchestrator rules; discovery verified statically.)
- [PASS] The new `tests/node/smoke.test.ts` is discovered and passes.
  - Ran the single file: `node --test --import tsx tests/node/smoke.test.ts` →
    `pass 1, fail 0`. It imports `./helpers/smokeHelper.ts` (explicit `.ts`
    extension) and `tsx` resolves it correctly.
- [PASS] `pnpm typecheck` reports zero missing-type errors from deps (static judgment).
  - Enumerated every bare import under `migration/node/**/*.ts`: baileys, pino,
    sharp, axios, dotenv ship bundled `types`; ws, better-sqlite3, fs-extra,
    fluent-ffmpeg are covered by installed `@types/*` devDeps; node built-ins by
    `@types/node`. The only dep with neither bundled types nor an installed
    `@types/*` is `node-webpmux`, which is covered by `migration/node/types/ambient.d.ts`.
  - `tsconfig.json` `include: ["migration/node/**/*"]` picks up `ambient.d.ts`,
    so `sticker.ts`'s `import webpmux from 'node-webpmux'` typechecks (as `any`).
  - Tests are NOT in the `include` set, so the smoke test's explicit `.ts`
    import extension does not trigger a typecheck error.

## Files-claim verification

- CREATE `migration/node/types/ambient.d.ts` — EXISTS. Contains exactly one
  shim: `declare module 'node-webpmux';`. Verified node-webpmux's
  `package.json` has no `types`/`typings` field. Matches purpose.
- MODIFY `package.json` — `scripts.test` updated to run TS+mjs; `@types/*` devDeps
  present (`@types/better-sqlite3`, `@types/fluent-ffmpeg`, `@types/fs-extra`,
  `@types/node`, `@types/ws`) plus `tsx` and `typescript`. Matches.
- CREATE `tests/node/smoke.test.ts` — EXISTS; one `node:test` test importing a
  `.ts` helper, asserting `add(1,1) === 2`. Matches. (Helper
  `tests/node/helpers/smokeHelper.ts` also present.)

## 3. Issues

- [MINOR] migration/node/types/ambient.d.ts:6 — Doc comment references
  "imported in migration/node/wa/command/sticker.js" but the actual importing
  file is `sticker.ts` (the `.js` was migrated to `.ts`). Cosmetic comment-only
  inaccuracy; no functional impact.

## 4. Must NOT do / isolation / contract notes

- [OK] No production `.js` source was converted as part of this step's deliverables.
- [OK] No ambient declarations added for deps that already ship types or have an
  installed `@types/*` package — only `node-webpmux` is declared, which is the
  genuine gap.
- No CONTRACT.md / protocol surface touched (step references none). No per-tenant
  isolation or teardown concerns relevant to a test-runner/typing step.
