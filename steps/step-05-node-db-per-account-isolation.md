# Step 05 — Per-account DB isolation (fix the critical bug)
**Phase:** 1 · **Risk:** high · **Depends on:** step-04

## Goal
Give each tenant its own `Database` instance and repository set, owned by its
`AccountEntry`. Remove the module-global DB handles and the `initWithDbDir`
early-return so two tenants never share databases. This closes the
`CONTRACT.md` §8 isolation violation.

## Why (audit — Critical finding #1)
`db.ts` keeps DB handles as module-level singletons (`_settingsState` …
db.ts:220–223). `initWithDbDir()` early-returns if handles are already open
(db.ts:1123): `if (_settingsState.db && … ) return;`. So tenant #2 silently
reuses tenant #1's settings/stats/moderation/activation DBs. The in-code comment
(db.ts:1116–1121) admits this was deferred. Everything else on the Node side is
already per-account threaded (`getSock()` removed, caches/identifiers on
`AccountContext`) — the DB layer is the sole holdout.

## Changes
- `AccountEntry` (account/) constructs a `Database` for its tenant's `db/` dir
  and instantiates the repositories from step-04 against it. The entry owns
  `close()` of its `Database` on disconnect/teardown.
- Thread repositories to consumers through the existing per-account context
  (the same path that already carries `sock`/`AccountContext` into the command
  and action handlers). Replace calls to the global `db.ts` functions with calls
  on the injected repositories.
- Delete the module-global `_settingsState`/`_statsState`/`_moderationState`/
  `_subagentState`, the `init`/`initWithDbDir` early-return shims, and the
  temporary singleton shim from steps 03–04.
- **New test:** `tests/node/db-isolation.test.ts` — boot two `AccountEntry`
  instances on two distinct tenant dirs, write a setting/mute/model in tenant A,
  assert tenant B does not observe it and vice-versa. Use temp dirs; tear down
  both `Database` instances; run under a hard timeout.

## OOP / target
`AccountEntry` is the per-tenant composition root for persistence: it owns one
`Database` and N repositories. No DB state exists at module scope. The number of
live tenants is bounded only by resources, each fully isolated.

## Must NOT
- Must NOT change SQL/table semantics.
- Must NOT introduce a new global registry of Databases keyed by folderPath that
  re-creates sharing — ownership must be the `AccountEntry`.
- Must NOT regress single-account boot (the default tenant still works).

## Verification
- Node typecheck 0; full `node --test` no new failures; the new two-account
  isolation test passes; `pnpm dev` boots single-account and writes under the
  tenant `db/` dir.
- `git grep -n "_settingsState\|initWithDbDir"` in `src/` → 0.

## Done when
- DBs are per-`AccountEntry`; module-global handles gone; isolation test green;
  all gates green.
