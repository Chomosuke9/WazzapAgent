# Step 11 — TypeScript: `wa/command/*` (parser → handlers → barrel)

## Context
Convert the slash-command layer that stays in Node. Order within the step:
`parseCommand.ts` first, then the ~28 handler files, then the `index.ts` barrel.
Handlers depend on `db`/`config`/identifiers (already typed). Logic unchanged.

## Contract references
- `run_command` (CONTRACT.md §1.2) dispatches into these handlers later via
  `dispatchRunCommand`; this step does not change that path.
- `slashCommand` field (CONTRACT.md §7) is produced by `parseSlashCommand`.

## Files to read before starting
- Original - `migration/node/wa/command/parseCommand.js`
- `migration/node/wa/command/index.js`
- 3–4 representative handlers: `prompt.js`, `mode.js`, `model.js`, `setting.js`

## Files to create
None beyond renames.

## Files to modify
### `migration/node/wa/command/parseCommand.js` → `parseCommand.ts`
**Change:** Type `parseSlashCommand(text: string | null): { command: string; args: string } | null`
and the `COMMAND_ALIASES` map. Keep alias table verbatim.

### `migration/node/wa/command/*.js` → `*.ts` (all ~28 handlers)
**Change:** Rename and type each `handle*` export's params object and return.
May be done in sub-batches across commits but lands as one logical step. Logic
unchanged; these stay in Node.

### `migration/node/wa/command/index.js` → `index.ts`
**Change:** Convert the barrel re-exports.

## Files to delete
- The `.js` originals under `migration/node/wa/command/`.

## Acceptance criteria
- `pnpm typecheck` passes with zero errors.
- `pnpm dev` boots; `/help` and `/mode` execute without runtime/type error
  (manual check in a paired chat or via a unit test calling the handler with a
  fake context).
- `node --test 'tests/node/**/*.test.mjs'` passes.
- `git ls-files 'src/wa/command/*.js'` is empty.

## Must NOT do
- Do not change command behavior, permission gates, or alias mappings.
- Do not move any command logic to Python.
- Do not change the `wsClient.sendReliable` calls inside handlers yet (Step 21).

## Depends on
Step 08, Step 09.
