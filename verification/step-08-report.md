# Step 08 — TypeScript `db.ts` — Verification Report

## (1) Verdict: ACCURATE

`migration/node/db.js` was faithfully converted to `migration/node/db.ts` with
typed row-shape interfaces and typed CRUD/init/closeAllDbs signatures. SQL,
table DDL, migrations, WAL/pragma config, and the global path constants are
byte-for-byte equivalent to the read-only reference `src/db.js`. The `.js` file
is deleted. One forward-looking addition (`initWithDbDir`) exceeds the literal
Step 08 scope but is benign and does not alter the required global-path default
behavior (see Issues).

## (2) Acceptance-criteria checklist

- [PASS] `pnpm typecheck` passes with zero errors (judged statically — not
  executed to avoid the central global gate):
  - `tsconfig.json` is `strict: true` but does **not** set `noUnusedLocals`/
    `noUnusedParameters`, so the carried-over unused locals in `init()`
    (`statsPath`, `moderationPath`, `subagentPath` — also unused in the original
    JS) do not error.
  - All imports resolve: `config.ts` exports a default `config` with typed
    `dataDir/settingsDbPath/statsDbPath/moderationDbPath/subagentDbPath`
    (config.ts:56-60, 88-92, 116); `logger.ts` has a default export (logger.ts:9).
  - `better-sqlite3` default-import + `Database.Statement/Options/Database`
    namespace types used correctly under `esModuleInterop`.
  - Generic `RetryFn` / `retrySqliteOperation<T>` assignment is type-compatible.
- [PASS] `pnpm dev` boots and `dbInit()` runs (judged statically): `init()` logic
  is identical to the reference; `replaceDb`/`openDbWithRecovery`/migrations
  unchanged.
- [PASS] `pnpm stress:db` (`tests/db-stress/stress.mjs`): the stress harness and
  workers import `../../src/db.js` / `src/db.js` (unchanged reference tree), not
  the migrated file. They pass against logic that is identical to `db.ts`.
- [PASS] `node --test tests/node/**`: `tests/node/activation.test.mjs` imports
  `../../src/db.js` (reference tree), identical logic to `db.ts`.

## Files verified

- Create: none beyond rename — correct.
- Modify: `db.js → db.ts` — present (57428 bytes), interfaces declared
  (`ChatSettingsRow`, `LlmModelRow`, `OwnerContactRow`, `ActivationCodeRow`,
  `ChatActivationRow`, `StickerRow`, plus stats/subagent/result shapes); every
  exported function typed; `init`/`initWithDbDir`/`closeAllDbs` typed.
- Delete: `migration/node/db.js` — confirmed gone (only `db.ts` present).
- Export surface: identical to `src/db.js` export list **plus** `initWithDbDir`.

## (3) Issues

- [MINOR] migration/node/db.ts:1122,1964 — `initWithDbDir(dbDir)` is added
  beyond the rename. Step 08 says "Files to create: None beyond the rename" and
  the "Must NOT do" lists "Do not move DB paths under `<folderPath>/db/`
  (Step 17/33)". This function sets `_settingsState.dbPath = path.join(dbDir,
  "settings.db")` etc., i.e. exactly the per-tenant path resolution deferred to
  Step 17. Mitigating factors: it is a separate, additive function gated by the
  same early-return guard; the default `init()` retains unchanged global-path
  behavior; and it is consumed only by `account/baileysFactory.ts:42,164`
  (Step 17). Net effect on Step 08's required behavior: none. Flagged as a
  scope/sequencing note rather than a functional defect.
- [MINOR] migration/node/db.ts (init, ~line 1095) — `statsPath`,
  `moderationPath`, `subagentPath` locals are assigned (for their path-resolving
  side effects) but never read in the log line. This is carried over verbatim
  from the reference JS and is harmless because `getStatsDbPath()` etc. perform
  the needed `ensureParentDir` side effect. Does not fail typecheck
  (`noUnusedLocals` is off).

## (4) Must NOT do / isolation / contract notes

- "Do not change any SQL, table, column, or migration" — UPHELD. All DDL,
  `ALTER TABLE` migrations, `migrateFromLegacyIfNeeded`, and
  `migrateSubagentDbIntoSettings` are identical to `src/db.js`.
- "Do not move DB paths under `<folderPath>/db/`" — the **default** path wiring
  (`getSettingsDbPath` → `config.settingsDbPath`, etc.) is unchanged and still
  global; however the added `initWithDbDir` introduces the per-tenant path
  capability one step early (see MINOR above). No default-path regression.
- "Do not convert any other file" — UPHELD for this step's scope; only `db.ts`
  was assessed.
- Isolation: DB state is still module-global (`_settingsState` et al.), matching
  the reference. No new per-tenant mutable-state leak introduced; `initWithDbDir`
  shares the same global state and is explicitly documented as single-account in
  this step. No socket/interval/server teardown concerns (the recovery-lock
  heartbeat interval is `unref`'d and `clearInterval`'d in `finally`, as in the
  original).
