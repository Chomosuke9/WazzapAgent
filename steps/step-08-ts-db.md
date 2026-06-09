# Step 08 — TypeScript: `db.ts`

## Context
`db.js` (~47 KB) wraps `better-sqlite3` for settings, models, stats, mutes,
activation, stickers, and subagent state. Convert it to TypeScript with typed row
shapes. No schema or query changes. DB **path** wiring stays global here; the
per-tenant `db/` path resolution (CONTRACT.md §8) is wired later (Step 17 / 33).

## Contract references
- CONTRACT.md §8 (Folder Layout) — **awareness only**; this step keeps the
  current global path behavior and does **not** move DBs under `<folderPath>/db/`.

## Files to read before starting
- `src/db.js`
- `docs/llm-architecture/05-state-data-and-db.md` (table/column shapes)

## Files to create
None beyond the rename.

## Files to modify
### `src/db.js` → `src/db.ts`
**Change:** Rename; declare interfaces for row shapes (`ChatSettingsRow`,
`LlmModelRow`, `ChatActivationRow`, `ActivationCodeRow`, `OwnerContactRow`,
`StickerRow`) per doc 05; type every exported CRUD function and `init`/
`closeAllDbs`. Keep SQL, WAL config, migrations, and the global path constants
exactly as today.
**Location:** whole file.

## Files to delete
- `src/db.js`.

## Acceptance criteria
- `pnpm typecheck` passes with zero errors.
- `pnpm dev` boots and `dbInit()` runs without error against an existing `data/`.
- `pnpm stress:db` (`tests/db-stress/stress.mjs`) passes.
- `node --test 'tests/node/**/*.test.mjs'` passes.

## Must NOT do
- Do not change any SQL, table, column, or migration.
- Do not move DB paths under `<folderPath>/db/` (Step 17/33).
- Do not convert any other file.

## Depends on
Step 05.
