# Step 06 — Typed command registry + strict `CommandContext`
**Phase:** 2 · **Risk:** med · **Depends on:** step-05

## Goal
Replace the ad-hoc 5-site command dispatch with a single typed registry: each
command is a `CommandHandler` declaring its own name, aliases, and permission,
registered once. Delete the giant switch and the parallel alias table.

## Why (audit — High finding #5)
Adding a command today touches 5 places (handler file, `wa/command/index.ts`
barrel, import block in `commandHandler.ts`, a ~250-line `switch`, and
`COMMAND_ALIASES` in `parseCommand.ts:10–66`). The two registries already
drifted (`/dump` is aliased but has no switch case). Each case rebuilds a
partial context and does `as CommandContext` (~28 casts); `CommandContext` is
all-optional with an index signature (parseCommand.ts:97–156), erasing
compile-time safety.

## Changes
- Define `interface CommandHandler { name; aliases; permission?; run(ctx: CommandContext): Promise<...> }`
  in `wa/commands/`.
- Convert each `wa/command/*` module to export a `CommandHandler` object/class.
- `CommandRegistry`: builds a `Map<string, CommandHandler>` from the handlers
  (name + aliases resolved from the handler itself — single source of truth).
  Dispatch looks up the map; no switch.
- `CommandContext`: make it a **strict** type with required fields actually used
  by handlers; remove the index signature and the all-optional shape. Eliminate
  the `as CommandContext` casts (target: 0).
- Delete the dispatch `switch` and `COMMAND_ALIASES`; `parseCommand` keeps only
  raw text → `{command, args}` parsing.

## OOP / target
Open/closed command system: adding a command = add one handler file + register
it (ideally via an array import in one place). No drift between alias and
dispatch tables.

## Must NOT
- Must NOT change any command's behavior or output.
- Must NOT change the activation-gate semantics in the dispatch path.

## Verification
- Node typecheck 0; `node --test` no new failures (command tests pass).
- `git grep -n "as CommandContext\|COMMAND_ALIASES"` in `src/` → 0.
- Manually confirm previously-drifted `/dump` now routes correctly.

## Done when
- All commands are registry-driven handlers; switch + alias table gone; strict
  `CommandContext`; gates green.
