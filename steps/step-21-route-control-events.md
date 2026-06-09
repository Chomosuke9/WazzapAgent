# Step 21 — Route control events through the registry (per-account)

## Context
Slash-command handlers and `connection.ts` currently push control events
(`clear_history`, `set_llm2_model`, `invalidate_*`, `set_subagent_enabled`) via
the global `wsClient.sendReliable`. For multi-account they must go to the
**specific** account's client, so the command/connection layer must know which
`folderPath`/`AccountContext` it is acting for. Re-route every such call through
the registry with `folderPath` attached.

## Contract references
- **CONTRACT.md §1.5** — control-event shapes; this step adds `folderPath` at the
  top level of each control frame.
- **CONTRACT.md §1.6** — these remain **reliable**.

## Files to read before starting
- `src/wa/connection.ts` (model select, modelcfg remove, `whatsapp_status`,
  `invalidate_default_model` emits)
- `src/wa/command/*.ts` handlers that call `wsClient.sendReliable` (model, mode,
  prompt, permission, trigger, reset, subagent, idle, announcement, modelcfg)
- `src/wa/commandHandler.ts` (the `context` object threaded to handlers)
- `src/server/accountRegistry.ts`

## Files to create
None.

## Files to modify
### `src/wa/commandHandler.ts`
**Change:** Thread the acting account (`folderPath`/`AccountContext`) into the
`context` passed to each `handle*` and to `handleButtonResponse`.
**Location:** `handleCommandListener` signature + `context` construction.

### `src/wa/command/*.ts` (control-emitting handlers)
**Change:** Replace `wsClient.sendReliable({ type, … })` with
`registry.sendReliableToClient(folderPath, { type, folderPath, … })`.
**Location:** each `wsClient.sendReliable` call.

### `src/wa/connection.ts`
**Change:** Same replacement for the `set_llm2_model`/`invalidate_*`/
`whatsapp_status` emits in button handlers and `connection.update`.
**Location:** `handleButtonResponse`, `setDefaultModel`, `connection.update`.

## Files to delete
None.

## Acceptance criteria
- `pnpm typecheck` passes with zero errors.
- `tests/node/control-events.test.ts`: invoking the `/model` handler for account
  A's chat enqueues/sends `set_llm2_model` and `invalidate_llm2_model` to **A's**
  client only (with top-level `folderPath === A`), and nothing to a second
  account B.
- A control event emitted while A's client is disconnected is queued and flushed
  on reconnect (reuses Step 15 behavior).
- `node --test` green; `pnpm dev` (old single-account path) still functions —
  with one account the routed control events behave as before.

## Must NOT do
- Do not change control-event payload fields other than adding `folderPath`.
- Do not change command behavior or permissions.
- Do not flip the boot path (Step 28).

## Depends on
Step 15, Step 20.
