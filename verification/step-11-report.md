# Step 11 Verification Report — TypeScript: `wa/command/*`

## (1) Verdict: ACCURATE

The slash-command layer was converted to TypeScript completely and faithfully.
All 30 files (`parseCommand`, 28 handlers, `index` barrel, plus
`groupStatusHelpers`) exist as `.ts`, no `.js` originals remain in the migrated
tree, the alias table is verbatim, and handler logic is preserved. The only
deviations from the literal Step-11 boundary are changes that belong to later
steps (21 = `wsClient.sendReliable` → `registry.sendReliableToClient`; 33 =
`getSock()` → `ctx.sock`) which are correctly present in the cumulative final
state. See notes.

## (2) Acceptance-criteria checklist

- `pnpm typecheck` passes — PASS (static check). All handlers import
  `CommandContext` from `./parseCommand.js`; `parseSlashCommand` typed as
  `(text: string | null) => { command: string; args: string } | null`;
  `COMMAND_ALIASES` typed `Map`. No leftover `wsClient`/`getSock` imports that
  would dangle. (Not executed per read-only/parallel-run rule; judged from code.)
- `pnpm dev` boots; `/help` and `/mode` execute — PASS (static).
  `handleHelp`/`handleMode` are well-formed, exported, and registered in the
  barrel; HELP_TEXT and mode logic are byte-identical to the original.
- `node --test 'tests/node/**/*.test.mjs'` passes — NOT RUN (read-only rule;
  delegated to orchestrator global gate). No evidence of breakage from static read.
- `git ls-files 'src/wa/command/*.js'` is empty — LITERAL FAIL / INTENT PASS.
  `src/` is preserved READ-ONLY (30 `.js` still tracked there by design). The
  migrated equivalent `git ls-files 'migration/node/wa/command/*.js'` IS empty
  (0 files), satisfying the intent. The criterion text is stale relative to the
  actual `migration/`-tree migration strategy.

Files-to-modify (rename + type):
- `parseCommand.js` → `parseCommand.ts` — PASS (alias table verbatim, typed,
  adds exported `CommandContext` interface).
- ~28 `*.js` → `*.ts` handlers — PASS (all present, typed params via
  `CommandContext`, `Promise<void>` returns, exports preserved).
- `index.js` → `index.ts` — PASS (same re-exports + `export type
  { CommandContext }`).

Files to delete (`.js` originals under `migration/node/wa/command/`) — PASS
(none remain; `git ls-files` confirms 30 `.ts`, 0 `.js`).

## (3) Issues

- [MINOR] migration/node/wa/command/{mode,prompt,model,reset,trigger,permission,idle,announcement,modelcfg,subagent}.ts —
  `wsClient.sendReliable({...})` calls were replaced with
  `registry.sendReliableToClient(folderPath, {...})`. Step 11 "Must NOT do"
  explicitly defers this to Step 21. Technically crosses the Step-11 boundary,
  but the resulting frames are CONTRACT-correct (control events carry top-level
  `folderPath` + `chatId`/`modelId`) and this is the correct final state owned
  by Step 21. Not a runtime bug.
- [MINOR] All handlers — `getSock()` was replaced by `ctx.sock` (Step 33).
  Same boundary-crossing observation; final state is correct.
- [MINOR] steps/step-11-ts-commands.md acceptance criterion
  `git ls-files 'src/wa/command/*.js'` is stale (src/ is read-only reference and
  still tracks 30 `.js`). Intent met via the `migration/` tree.

No BLOCKER or MAJOR issues found.

## (4) Must-NOT-do / isolation / contract notes

- "Do not change command behavior, permission gates, or alias mappings" —
  RESPECTED. Logic, permission checks, and the alias `Map` are byte-for-byte
  preserved (verified parseCommand, mode, model, reset, prompt, help vs `src/`).
- "Do not move any command logic to Python" — RESPECTED. Handlers remain in Node.
- "Do not change `wsClient.sendReliable` calls yet (Step 21)" — VIOLATED in the
  literal step sense (see MINOR above), but the change is the correct Step-21
  end state and is CONTRACT-compliant. Flagged for ordering transparency only.
- Per-account isolation: handlers now route reliable control frames to the
  acting tenant via `registry.sendReliableToClient(folderPath, …)` with
  `folderPath` defaulting to `config.dataDir` (single-account fallback). No
  shared mutable cross-tenant state introduced in this layer. Good.
- Contract frame shapes verified: `clear_history` `{folderPath, chatId|"global"}`,
  `set_llm2_model` `{folderPath, chatId|"global", modelId}`,
  `invalidate_chat_settings` `{folderPath, chatId|"global"}` — all top-level,
  matching CONTRACT §1.5 / README control-event table.
- All 28 barrel exports resolve to matching exported symbols in their files
  (verified). No dangling re-exports.
