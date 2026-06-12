# Step 02 — Cutover: promote `migration/` to top-level
**Phase:** 0 · **Risk:** med · **Depends on:** step-01

## Goal
Move the live tree out from under `migration/` so the project has a clean,
conventional layout: `migration/node → src`, `migration/python → python`,
`migration/data → data`. Update every path/config reference. No code logic
changes.

## Why (audit)
The `migration/` prefix was a migration-time scaffold. Keeping it permanently is
confusing and inconsistent with `package.json` conventions. With legacy trees
gone (step-01), the live tree should own the canonical paths.

## Changes
- `git mv migration/node src`, `git mv migration/python python`,
  `git mv migration/data data` (merge/replace the old root `data/` — keep one).
  Remove the now-empty `migration/` dir.
- **Node path config:** `tsconfig.json` `include` (`migration/node/**` → `src/**`);
  `package.json` `dev`/`start`/`test`/`main` (`tsx src/index.ts`, test glob if it
  referenced migration). Node import specifiers are relative `.js` and survive
  the move unchanged — verify with typecheck.
- **Python path config:** test command `PYTHONPATH=migration/python` → `PYTHONPATH=python`;
  `conftest.py`, any `sys.path` inserts; imports stay `bridge.*` / `wasocket.*`.
- **Hardcoded strings:** `git grep -n "migration/"` across the repo → fix every
  remaining literal (config defaults, docs-in-code, test fixtures, default data
  dir paths in `config.ts`/`config.py`).
- Re-record the Python baseline failure set after the move (paths changed).

## OOP / target
None (move + repoint only).

## Must NOT
- Must NOT restructure internal module layout (that starts in Phase 1).
- Must NOT change behavior or protocol.

## Verification
- `git grep -n "migration/"` → no stale references (only this plan/docs may
  mention it historically).
- Node: typecheck 0; `node --test` no new failures; `pnpm dev` boots.
- Python: `PYTHONPATH=python … pytest python/tests` → only the known env
  failures (newly re-recorded baseline).

## Done when
- Tree is `src/` + `python/` + `data/`; `migration/` gone; all gates green.
