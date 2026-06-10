# Step 18 — `eventForwarder.ts` — Verification Report

## (1) Verdict: ACCURATE

The per-account Baileys→Python event forwarder is implemented as specified.
`incoming_message` and `whatsapp_status` are routed through the registry with
`folderPath` stamped and `WaStatus` normalized. All three synthetic emitters in
`events.ts` and the inbound path in `inbound.ts` go through the forwarder. The
matching test file exists and exercises isolation, normalization, and reliable
queueing.

## (2) Acceptance-criteria checklist

| Criterion | Status | Evidence |
|---|---|---|
| `pnpm typecheck` passes (zero errors) | PASS (static) | `eventForwarder.ts` uses correctly-typed `WhatsAppMessagePayload`/`WhatsAppStatusPayload`/`OutboundFrame`; `forwardStatus` builds the exact `WhatsAppStatusPayload` shape (`folderPath`, `status`, `instanceId`, optional `reason`). No obvious type errors. Could not run the compiler per read-only/no-suite rules. |
| Test: fake upsert for A delivered ONLY to A's client; payload `folderPath === A` | PASS | `tests/node/event-forwarder.test.ts` test 1 binds A and B, forwards to A, asserts `clientA.sent.length===1`, `clientB.sent.length===0`, and `frame.payload.folderPath===folderA`. |
| Test: `connection.update` close forwarded as `whatsapp_status` `status:"close"` (not `"closed"`) | PASS | Test 2 feeds raw `'closed'`, asserts `payload.status==='close'` and `!== 'closed'`; also unit-tests `normalizeWaStatus`. |
| Status event while client unbound is queued (reliable) and delivered after bind | PASS | Test 3 forwards while unbound → `reliableQueue.length===1`; after `bindClient`+`flushReliableQueue` → delivered, queue drained. Backed by `forwardStatus` calling `registry.sendReliableToClient`. |
| `node --test` green | PASS (static) | Test logic is consistent with the implementation; not executed per the strict no-suite rule. |

## Files

- CREATE `migration/node/account/eventForwarder.ts` — EXISTS. Exports
  `forwardIncoming(entry, payload)`, `forwardStatus(entry, status, reason?)`,
  `normalizeWaStatus`, `bindForwarder` (the AccountEntry-binding factory), and
  the `AccountForwarder` interface. `forwardIncoming` stamps
  `payload.folderPath = entry.folderPath` and sends best-effort via
  `registry.sendToClient`. `forwardStatus` normalizes `closed→close` and sends
  reliably via `registry.sendReliableToClient`. No action handling, no control
  events, no WS server — scope guard respected.
- MODIFY `migration/node/wa/inbound.ts` — EXISTS. Imports `forwardIncoming`;
  payload now includes `folderPath: entry.folderPath` and the direct
  `wsClient.send` is replaced by `forwardIncoming(entry, payload)`.
- MODIFY `migration/node/wa/events.ts` — EXISTS. All three emitters
  (`emitGroupJoinContextEvent`, `emitBotActionContextEvent`,
  `emitBotRoleChangeEvent`) call
  `forwardIncoming(registry.getOrCreate(ctx.folderPath), payload)`.
- DELETE — none required; none performed.

## (3) Issues

- [MINOR] `migration/node/account/eventForwarder.ts:~110` (`bindForwarder`) —
  The exported `bindForwarder`/`AccountForwarder` factory is dead code. The spec
  describes it as the callback factory installed by `baileysFactory`, but
  `baileysFactory.ts` instead calls `forwardStatus(entry, …)` directly and the
  inbound path calls `forwardIncoming(entry, …)` via `inbound.ts`. The export is
  unused. Harmless (no behavior impact), just not wired as the spec narrative
  implies.

No BLOCKER or MAJOR issues found.

## (4) Must-NOT-do / isolation / contract notes

- "Do not change `incoming_message` field semantics other than adding
  `folderPath`" — RESPECTED. Compared against original `src/wa/inbound.js:357`
  and `src/wa/events.js` (3× `wsClient.send`, best-effort). The migrated payload
  fields are unchanged; only `folderPath` is added and delivery is best-effort
  via `sendToClient` — matching the original best-effort semantics.
- "Do not route actions or control events here" — RESPECTED. `eventForwarder.ts`
  handles only `incoming_message` and `whatsapp_status`.
- "Do not flip the boot path" — RESPECTED. No boot wiring changed in this step.
- Reliable vs best-effort contract (CONTRACT.md §1.6 / ADR-4): `incoming_message`
  best-effort, `whatsapp_status` reliable — both correct.
- `WaStatus` normalization (CONTRACT.md §1.1): `closed→close` handled in both
  `eventForwarder.normalizeWaStatus` and `baileysFactory.normalizeWaStatus`;
  parity with original which emitted raw `"closed"` (now correctly normalized).
  Original forwarded status only on `open`/`close` (not `connecting`); the
  migration preserves that exactly.
- `folderPath` routing (CONTRACT.md §7): always stamped on `incoming_message`
  and present on `whatsapp_status`; delivery goes through the per-account
  registry, so no cross-tenant leak (verified by the isolation test).
- Per-account isolation: forwarder holds no module-level mutable state; all
  state lives on the `AccountEntry`/registry keyed by `folderPath`. No shared
  mutable singletons introduced.
- No leftover `wsClient` references remain anywhere under `migration/node`
  (grep returned zero matches).
