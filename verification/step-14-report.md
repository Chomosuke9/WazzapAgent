# Step 14 Verification Report — TypeScript `wsClient.ts` and `index.ts`

Spec: `steps/step-14-ts-wsclient-index.md`

## (1) Verdict: ACCURATE (with supersession caveat)

Step 14 was the final Phase-2 JS→TS conversion of the live WS **client**
(`wsClient`) and the entrypoint/dispatcher (`index`). The repository under audit
is a **single cumulative snapshot of the FINAL migration state** (only 3 git
commits; no per-step history). By the final state, the later topology-flip steps
**28/30** — which Step 14 explicitly defers to in its "Must NOT do" — have
removed `wsClient.ts` entirely and rewritten `index.ts` as the WS **server**
bootstrap. Therefore Step 14's intermediate-specific artifacts are no longer
present in their step-14 form, and that is **expected, correct sequential
behavior, not a defect**.

The enduring outcome of Step 14 is fully satisfied: the entire `migration/node/`
tree is TypeScript, no `.js` remains there, and `wsClient.js`/`index.js` are
deleted. Strong indirect evidence confirms a real `wsClient.ts` existed:
`migration/python/wasocket/transport.py:72` documents `compute_reconnect_delay`
as a "Pure port of `wsClient.ts` `computeReconnectDelay`", and
`migration/python/tests/test_transport.py` cites the now-removed
`tests/node/wsClient.test.mjs` as the source coverage it ported.

## (2) Acceptance-criteria checklist

- **No `.js` remains under `migration/node/`** — PASS. `git ls-files
  'migration/node/**/*.js'` returns empty; all 66 node files are `.ts`. (The
  spec literally wrote `git ls-files 'src/**/*.js'`, which is NON-empty — but
  `src/` is the read-only ORIGINAL reference tree, not the migration target.
  This is a spec wording typo; the intended target `migration/node` passes.)
- **`wsClient.js` and `index.js` deleted** — PASS. Neither exists.
  `migration/node/index.ts` exists; `migration/node/wsClient.*` does not exist at
  all (the `.ts` was later removed by steps 28/30).
- **`index.ts` typed; uses `OutboundFrame`/`ActionAckPayload`/`WsErrorPayload`
  from `protocol/types.ts`** — SUPERSEDED / NOT VERIFIABLE in step-14 form. All
  four referenced types (`InboundFrame`, `OutboundFrame`, `ActionAckPayload`,
  `WsErrorPayload`) DO exist in `migration/node/protocol/types.ts` (lines
  81/160/92/97), but the final `index.ts` is the Step-28 thin server-bootstrap
  (it no longer contains `dispatchCommand`/`emitActionAck`/`deriveKickFailure`,
  which moved to `account/actionDispatcher.ts`). Cannot inspect step-14's typed
  `dispatchCommand` from this snapshot.
- **`pnpm typecheck` passes, zero errors** — NOT RUN. `typecheck` script
  (`tsc --noEmit`) exists in `package.json`. Not executed per the strict
  read-only / no-heavy-gate rule (central gate). Cannot independently confirm.
- **`pnpm dev` smoke (inbound → `send_message` → WhatsApp)** — NOT STATICALLY
  VERIFIABLE; runtime gate. The `dev` path is now the server topology, not the
  step-14 client path.
- **`node --test 'tests/node/**/*.test.mjs'` incl. `computeReconnectDelay`
  tests** — SUPERSEDED. `tests/node/wsClient.test.mjs` no longer exists (removed
  with `wsClient`). Reconnect coverage now lives in
  `migration/python/tests/test_transport.py`. The specific node reconnect test
  Step 14 names is gone.

## (3) Issues

- [MINOR] `steps/step-14-ts-wsclient-index.md` (acceptance criteria) — the
  "no `.js` remains" check is written as `git ls-files 'src/**/*.js'`, but
  `src/` is the read-only original tree (still full of `.js`). The check should
  target `migration/node`. Spec typo; migration target is clean.
- [MINOR] snapshot limitation — `migration/node/wsClient.ts` and
  `tests/node/wsClient.test.mjs` are absent in the final state (removed by steps
  28/30). Step-14's exact `wsClient.ts` (typed `LLMWebSocket`,
  `computeReconnectDelay`, reliable queue, heartbeat timers) and the in-file
  `dispatchCommand` in `index.ts` cannot be inspected directly here. Verified
  only via surviving evidence (Python port references; full TS conversion).

No BLOCKER or MAJOR issues found.

## (4) Must-NOT-do / isolation / contract notes

- "Do not flip the WS direction or remove `wsClient` (Steps 28/30)" — Not
  violated by Step 14. The flip/removal present in the final snapshot is
  attributable to steps 28/30, which Step 14 explicitly anticipates.
- "Do not move `dispatchCommand` into `actionDispatcher` (Step 19)" /
  "Do not change reconnect/backoff/heartbeat numbers" — Cannot be assessed
  against the step-14 artifact (superseded). The final `actionDispatcher.ts`
  owning dispatch is a later-step outcome, not a Step-14 violation.
- No per-account isolation, teardown, or contract-frame concerns are
  introduced by anything attributable to Step 14 in the surviving code.
  `index.ts` correctly closes the WS server and DBs on shutdown.

## What was checked
Read the full step spec; confirmed deletion of `wsClient.js`/`index.js`;
enumerated all 66 `migration/node` files (all `.ts`); ran `git ls-files` for
`.js` under `migration/node` (empty); read the final `index.ts`; grepped
`computeReconnectDelay`/`wsClient` references across `migration/`; confirmed the
four protocol types exist in `protocol/types.ts`; and confirmed `package.json`
has `typecheck`/`dev`/`test` scripts. Did not run typecheck, dev, or the test
suite per the read-only constraints.
