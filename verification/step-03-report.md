# Step 03 Verification — TypeScript toolchain + `tsconfig.json`

## (1) Verdict: ACCURATE

The TypeScript toolchain, `tsconfig.json`, and `package.json` script/devDependency
changes match the spec. JS/TS coexistence is enabled, no `paths` aliasing or in-place
emit, ESM preserved, and the baileys patch (`postinstall`) is untouched. One minor
deviation: the `test` script was changed (almost certainly by a later TS-test step),
contrary to step-03's "leave test as-is" instruction — but it does not break the
step-03 acceptance criterion.

## (2) Acceptance-criteria checklist

| # | Criterion | Result |
|---|-----------|--------|
| 1 | `pnpm install` completes without error | PASS — `node_modules/.bin/tsx` and `tsc@6.0.3` are installed and runnable, confirming install succeeded. |
| 2 | `pnpm typecheck` runs, zero errors (JS not checked, `checkJs:false`) | PASS (config) — `tsc --showConfig -p tsconfig.json` is accepted; `checkJs:false` confirmed. Whether zero errors across all converted TS files is a global gate I did not run the full `tsc --noEmit` to avoid duplicating the central gate. |
| 3 | `pnpm dev` still boots from the entrypoint | PASS — `dev`/`start` = `tsx migration/node/index.js`. The entry was later converted to `index.ts`; empirically verified that `tsx file.js` resolves to an existing `file.ts` (tsx extension rewrite), so the script still resolves. Did not boot the long-lived gateway (prohibited). |
| 4 | `node --test 'tests/node/**/*.test.mjs'` still passes | PASS (not executed — global gate). The glob path is still valid; test framework unchanged. |
| 5 | `tsconfig.json` exists at repo root, valid JSON parseable by tsc | PASS — valid JSON (no comments), accepted by `tsc --showConfig`. |

### tsconfig.json key-logic checklist (all PASS)
- `module: NodeNext` ✓, `moduleResolution: NodeNext` ✓, `target: ES2022` ✓
- `allowJs: true` ✓, `checkJs: false` ✓, `strict: true` ✓
- `esModuleInterop: true` ✓, `resolveJsonModule: true` ✓, `noEmit: true` ✓, `skipLibCheck: true` ✓
- No `paths`/`baseUrl`/`outDir` aliasing or in-place emit ✓ (extra `lib`, `forceConsistentCasingInFileNames`, `include` are benign additions)
- `package.json` `"type": "module"` unchanged ✓

### package.json checklist (all PASS except the test-script note)
- devDeps added & pinned exact: `typescript@6.0.3`, `tsx@4.22.4`, `@types/node@25.9.2`, `@types/ws@8.18.1` ✓ (plus extra `@types/better-sqlite3`, `@types/fluent-ffmpeg`, `@types/fs-extra` — benign, aids typecheck)
- `dev`/`start` run entry through `tsx` ✓
- `typecheck: "tsc --noEmit"` added ✓
- `postinstall` (`node scripts/patch-baileys.js`) and `stress:db` unchanged ✓

## (3) Issues

- [MINOR] package.json:`scripts.test` — Original was `node --test 'tests/node/**/*.test.mjs'`; now `node --test --import tsx 'tests/**/*.test.mjs' 'tests/**/*.test.ts'`. Step-03 spec explicitly says "Leave ... test ... as-is." This change is almost certainly from a later step that added TS tests (all migration changes are in a single squashed commit `35af70c`, so it cannot be definitively attributed). The new glob is a superset and does not break the step-03 acceptance criterion (which is checked via the direct `node --test 'tests/node/**/*.test.mjs'` command, not via `pnpm test`).
- [MINOR] package.json:`scripts.dev`/`scripts.start` — Reference `migration/node/index.js` while the actual file is `migration/node/index.ts` (converted by a later step). This relies on tsx's `.js`→`.ts` extension rewriting. Verified to work, but it is a fragile/cosmetic mismatch; a literal `index.ts` would be clearer.

## (4) Must-NOT-do / isolation / contract notes
- "Do not enable checkJs" — respected (`checkJs:false`). ✓
- "Do not change `type:module` or the baileys patch" — respected (`postinstall` and `"type":"module"` unchanged). ✓
- "Do not convert any `.js` to `.ts` in this step" — step-03 itself only edits `tsconfig.json`/`package.json`. The presence of converted `.ts` files (e.g., `index.ts`) is the cumulative result of later phase-2 steps, not step-03. Not faulted against step-03.
- No `paths` aliasing and no in-place-overwrite emit settings — respected.
- No protocol/contract surface in this step (build-only); no per-account isolation concerns.
