# Step 03 — Extract `Database` class + `db/schema` from `db.ts`
**Phase:** 1 · **Risk:** med · **Depends on:** step-02

## Goal
Carve the low-level concerns out of the 2,019-line `db.ts` into a `db/` folder:
a `Database` class that owns a single tenant's connections (open, recover,
migrate, close) and a `db/schema/` module for table creation + migrations. This
is a **structural split with no behavior change** and is the foundation for the
isolation fix in step-05.

## Why (audit)
`db.ts` is a god-module mixing ~12 domains: sqlite driver/recovery
(lines ~259–342, 453–654), schema/migrations (~656–1201), and per-domain
accessors (settings/stats/models/moderation/activation/subagent/idle/
announcement/global). The module-global handles `_settingsState`/`_statsState`/
`_moderationState`/`_subagentState` (db.ts:220–223) are the root of the
multi-account bug; they cannot be fixed until connection management is
encapsulated.

## Changes
- New `src/db/Database.ts`: a class encapsulating the four logical DBs
  (settings, stats, moderation, subagent) for **one** tenant — open with a base
  dir, WAL setup, the existing recovery/`probeDb`/`replaceDb` logic, and
  `migrateFromLegacyIfNeeded`. Constructor takes the tenant's `db/` directory.
  Methods: `open()`, `close()`, and connection getters used by repositories.
- New `src/db/schema/`: move `initSettingsTables`/`initStatsTables`/
  `initModerationTables`/`initSubagentTables` + migration helpers verbatim.
- For this step only, keep the existing exported functions working by having
  them delegate to a single process-wide `Database` instance (a temporary
  shim) — so callers are untouched and gates stay green. The shim is removed in
  step-05.

## OOP / target
`Database` is the connection-owner aggregate. No SQL for domain data lives in
it — only lifecycle + raw connection access. Schema/migrations are pure
functions in `db/schema/`.

## Must NOT
- Must NOT change SQL semantics, table shapes, or recovery behavior.
- Must NOT yet touch repository/domain function signatures (step-04).
- Must NOT remove the module-global shim yet (step-05 does that).

## Verification
- Node typecheck 0; `node --test` no new failures; `pnpm dev` boots and DB
  files appear under the tenant `db/` dir as before.

## Done when
- `db.ts` lifecycle/schema code lives in `src/db/Database.ts` + `src/db/schema/`;
  all existing callers compile unchanged via the temporary shim; gates green.
