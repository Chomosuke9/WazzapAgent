# Step 21 — Route control events through the registry (per-account) — Verification Report

## (1) Verdict: ACCURATE

The control-event routing was fully migrated from the global
`wsClient.sendReliable` to per-account `registry.sendReliableToClient(folderPath, …)`,
with a top-level `folderPath` added to every control frame, matching
CONTRACT.md §1.5 and preserving the reliable guarantee (§1.6).

## (2) Acceptance-criteria checklist

- [PASS] `pnpm typecheck` — judged statically: all control frames are typed in
  `protocol/types.ts` `OutboundFrame` with top-level `folderPath`
  (lines 168–172); handlers destructure `folderPath` and pass typed frames.
  No leftover `wsClient.sendReliable` references remain (grep = 0 matches).
- [PASS] `/model` routes `set_llm2_model` + `invalidate_llm2_model` to acting
  account only, with top-level `folderPath === A`, and nothing to account B —
  covered exactly by `tests/node/control-events.test.ts` (first test) and matches
  the code in `connection.ts` `handleButtonResponse` (lines 421–431, using
  `account.folderPath`) and `command/model.ts` (lines 64–76).
- [PASS] Control event emitted while client disconnected is queued and flushed
  on reconnect — `accountRegistry.sendReliableToClient` enqueues onto the
  per-account `reliableQueue` when not OPEN (lines 130–151); `bindClient`/flush
  drains FIFO. Covered by the second test in `control-events.test.ts`.
- [PASS] `node --test` green / single-account path still works — each handler
  defaults `folderPath = config.dataDir` (10/10 handlers) and `commandHandler`
  resolves `context.folderPath ?? context.account?.folderPath ?? config.dataDir`,
  preserving single-account behavior. (Not executed per read-only rules; judged
  statically.)

## Files to modify — all confirmed

- `commandHandler.ts`: resolves `folderPath` and threads it into all
  control-emitting handlers (prompt, reset, permission, mode, trigger, model,
  modelcfg, subagent, idle, announcement). `handleButtonResponse` receives
  `account: AccountContext` (connection.ts:328-332) and builds context with
  `account`.
- `command/*.ts` (10 handlers): every `wsClient.sendReliable` replaced with
  `registry.sendReliableToClient(folderPath, { type, folderPath, … })`. Frame
  types verified against §1.5: clear_history, set_llm2_model,
  invalidate_llm2_model, invalidate_default_model, invalidate_chat_settings,
  set_subagent_enabled.
- `connection.ts`: `setDefaultModel` (line 292), `handleButtonResponse`
  model_select (421/427) and settings-remove (569/574) all route via
  `registry.sendReliableToClient(account.folderPath, …)`.

## (3) Issues list

None of BLOCKER/MAJOR severity.

- [MINOR] steps/step-21 spec text — The spec lists `whatsapp_status` in
  `connection.update` as something this step re-routes. In the actual code
  `whatsapp_status` is emitted by `account/eventForwarder.ts` (Step 18), not
  `connection.ts`. This is a stale spec reference, not an implementation defect;
  `whatsapp_status` is already routed reliably per-account elsewhere.
- [MINOR] `protocol/types.ts:168-172` — control-frame `chatId` is typed as
  `string` rather than `string | "global"`. Functionally harmless ("global" is a
  string), and `model.ts`/`reset.ts`/`announcement.ts` pass `"global"` without
  type error. Cosmetic only.

## (4) Must-NOT-do / isolation / contract notes

- "Do not change control-event payload fields other than adding folderPath" —
  RESPECTED. All frames keep their original fields (chatId, modelId, enabled)
  and only add top-level `folderPath`.
- "Do not change command behavior or permissions" — RESPECTED. Permission gates
  in each handler are unchanged.
- "Do not flip the boot path (Step 28)" — RESPECTED. Single-account fallback via
  `config.dataDir` preserves existing boot.
- Per-account isolation — PRESERVED. `sendReliableToClient` uses each account's
  own `reliableQueue`; the test verifies account B receives zero frames when A
  is the actor. No shared mutable cross-tenant state introduced.
- Reliable vs best-effort — CORRECT. Control events use the reliable
  (queue+flush) path per §1.6.
