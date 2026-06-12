# Step 01 — Delete legacy trees & repoint build/tests
**Phase:** 0 · **Risk:** med · **Depends on:** —

## Goal
Remove the dead pre-migration code so there is exactly one runtime tree. After
this step nothing builds, tests, or imports from the legacy `src/` (JS) or
top-level `python/` trees. `migration/` is untouched and still green.

## Why (audit)
Two parallel codebases (~30.7K LOC, 114 files) duplicate `migration/` and have
already diverged (21/36 bridge files differ). `npm test` runs tests that import
the **dead** `src/` tree (`tests/node/broadcast.test.mjs`, activation,
groupStatus), so the migrated modules are untested while obsolete ones are.
`package.json` `"main": "src/index.js"` is a stale pointer. Dual maintenance is
a standing hazard.

## Changes
- Delete the legacy `src/` directory (pre-migration JS gateway).
- Delete the legacy top-level `python/` directory (pre-migration bridge).
- Delete `examples/llm_ws_echo.py` (deprecated legacy-topology example) and any
  README section that only documents it.
- `package.json`: fix `"main"` (point at the migration entry for now,
  `migration/node/index.ts`; step-02 will move it to `src/index.ts`). Audit
  `dev`/`start`/`test` scripts — they must target `migration/` only.
- Tests: any test under `tests/` that imports the legacy `src/` (e.g.
  `broadcast`, `activation`, `groupStatus`, db-stress workers) must be either
  **ported** to import the `migration/node` equivalent or **deleted** if a
  migration-side test already covers it. No test may import the deleted trees.
- `git grep -n "from .*\\bsrc/\\|require(.*src/\\|from python\\.\\|python/bridge"`
  across `tests/` and `migration/` must return only intentional matches
  (none pointing at deleted trees).

## OOP / target
None (deletion + repoint only).

## Must NOT
- Must NOT move or rename `migration/` yet (that is step-02).
- Must NOT change any logic inside `migration/`.
- Must NOT touch `CONTRACT.md`.

## Verification
- `git grep` shows zero references to the deleted `src/`/`python/` trees from
  build config, `tests/`, or `migration/`.
- Node gates green (typecheck 0; `node --test` no new failures — the 3 legacy
  `broadcast` failures should now be gone or the test ported).
- Python gates green (`PYTHONPATH=migration/python … pytest migration/python/tests`
  → only the ~20 known env failures).
- `pnpm dev` still boots `ws server listening`.

## Done when
- `src/` and top-level `python/` no longer exist; all gates green; `git status`
  shows only the intended deletions/edits.
