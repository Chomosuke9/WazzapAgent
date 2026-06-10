# Step 13 Verification — TypeScript orchestrators (`wa/commandHandler`, `wa/connection`, `wa/index`)

Spec: `steps/step-13-ts-orchestrators.md`
Scope: convert `commandHandler.js`, `connection.js`, `wa/index.js` to TS, type
`handleCommandListener`/`startWhatsApp`/button+form helpers/barrel, delete the
three `.js` originals. Behavior unchanged; single global `sock` retained (per
spec, later removed by Steps 16/17/33).

> Note on auditing the FINAL repo state: `connection.ts` and `commandHandler.ts`
> have been further evolved by downstream steps (17 = factory extraction +
> account-parameterized button handler; 21 = `folderPath` reliable routing; 33 =
> `sock` threaded through `context` after the global `getSock()` was removed).
> The Step-13-specific deliverables are still verifiable and are present; one
> MAJOR regression from the downstream `sock`-threading refactor lives in the
> Step-13-owned `connection.ts` (see Issues).

## 1) Verdict: PARTIAL

Step 13's own conversion is complete and faithful (all three files are TS, all
three `.js` originals are gone, the barrel and the command `switch` match the
original behavior). However, the assigned file `connection.ts` contains a MAJOR
runtime regression in the button→slash-command path (missing `sock` in the
dispatched context) introduced by the later `sock`-threading refactor. Because
Step 13 explicitly must preserve button behavior and the defect resides in a
Step-13-owned file, the verdict is PARTIAL.

## 2) Acceptance-criteria checklist

- [PASS] `commandHandler.js` → `commandHandler.ts` exists; `handleCommandListener`
  and the `context` shape are typed (`ListenerMessage` union + `CommandListenerContext`);
  the full command `switch` is preserved 1:1 vs `src/wa/commandHandler.js`
  (same cases, same args, same activation-exempt set `{info, activate}`, same
  owner-gating for `generate`/`monitor`/`revoke`).
- [PASS] `connection.js` → `connection.ts` exists; `startWhatsApp`, `parseModelReply`,
  `handleButtonResponse`, and model-form helpers are typed. (`getSock` was
  legitimately removed by Steps 16/17 — see Must-NOT-do note.)
- [PASS] `index.js` → `index.ts` exists; barrel re-exports are byte-for-byte
  equivalent to the original (`withTimeout`, `startWhatsApp`, outbound, actions,
  `kickMembers`, presence, interactive set).
- [PASS] The three `.js` originals are deleted: `ls` shows only `.ts`; `git ls-files`
  returns nothing for the three `.js` paths.
- [PASS (static)] `pnpm typecheck` — judged to pass by static reading. `tsconfig.json`
  has `strict: true` but NOT `noUnusedLocals`, so the unused `isOwnerJid` import
  (carried over from the original) does not error. Command-context objects are
  cast `as CommandContext`, suppressing structural mismatches. `proto`/`WAMessage`
  type-only imports are valid. (Full `tsc` not run per the read-only/no-heavy-build
  rule.)
- [NOT RUN] `pnpm dev` QR + inbound/outbound round trip — not executed (read-only
  rule). Basic text round trip path (baileysFactory → handleCommandListener with
  `sock`) is statically coherent.
- [NOT RUN] `node --test 'tests/node/**/*.test.mjs'` — not executed per rules.

## 3) Issues

- [MAJOR] migration/node/wa/connection.ts:386-401 — In `handleButtonResponse`,
  the `context` object built for a button whose `selectedId` starts with `/`
  (dispatched via `handleCommandListener(fakeMsg, context)`) omits the `sock`
  field. After the downstream refactor removed the global `getSock()` and made
  command handlers read `ctx.sock` (e.g. `handleHelp({ chatId, sock })` →
  `sock.sendMessage`), this path passes `context.sock === undefined`, so any
  handler invoked from a button click throws on `sock.sendMessage(...)`. The
  throw is swallowed by the surrounding `try/catch` ("button response handler
  error") and the function returns `false`, so the command silently fails. This
  breaks the interactive model-config menus, which emit rows with
  `id: '/modelcfg edit|default <id>'` (see `showModelSelectionForEdit` /
  `showModelSelectionForDefault`). The two sibling dispatch sites set `sock`
  correctly: `account/baileysFactory.ts` (`sock,` at the upsert context) and
  `wa/runCommand.ts` (`sock: ctx.sock`). Fix: add `sock,` to the button-path
  context. Root cause is the Step-33 sock-threading refactor, not Step 13's
  conversion, but the defect lives in a Step-13-owned file and violates Step
  13's "do not change button behavior" intent in the final state.

- [MINOR] migration/node/wa/commandHandler.ts:33 — `import { isOwnerJid } from
  "../participants.js"` is unused (dead import). Harmless under the current
  tsconfig (`noUnusedLocals` off) and mirrors the original `commandHandler.js`,
  but it is dead code.

## 4) Must-NOT-do / isolation / contract notes

- "Do not remove the global `sock`/`getSock()` (Step 16/17)": In the FINAL state
  `getSock` is gone and `sock` is threaded via `AccountContext`/`context.sock`.
  This is the deliberate, documented work of Steps 16/17/33, not a Step 13
  violation. As a pure Step-13 diff this constraint would hold; against the
  final tree it is correctly superseded. Per-account isolation is preserved —
  the button/form state moved to `ctx.pendingForms` (per `AccountContext`), and
  `parseModelReply`/form helpers take `ctx`, so no cross-tenant shared mutable
  state in these files.
- "Do not move the two `messages.upsert` listeners into `eventForwarder`": The
  listeners now live in `account/baileysFactory.ts` (Step 17/18), which is the
  expected downstream destination, not `eventForwarder`. Consistent with final
  state.
- "Do not change command/button behavior": Command `switch` behavior is
  preserved. Button behavior is preserved EXCEPT for the MAJOR `sock`-omission
  regression above.
- Contract: Step 13 references no protocol changes. `connection.ts` no longer
  emits `whatsapp_status` itself (forwarded once by `eventForwarder` per Step
  18) — consistent with the contract and the final-state design; no reliable/
  best-effort or `folderPath` routing issues observed in these three files.
  Control events emitted from button/model handlers correctly use
  `registry.sendReliableToClient(folderPath, { ... folderPath ... })` with
  top-level fields (Step 21), matching CONTRACT §1.5.
