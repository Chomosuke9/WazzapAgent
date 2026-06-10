# Step 17 Verification — `baileysFactory.ts`

## (1) Verdict: ACCURATE

The core deliverable (`migration/node/account/baileysFactory.ts`) exists, exports
`createOrResumeAccount`, and faithfully generalizes the original single-global-`sock`
`startWhatsApp` into a per-`folderPath` factory bound to a per-account `AccountContext`.
`db.ts` gained the path-injecting `initWithDbDir` alongside the global `init`.
`connection.ts` was reduced to shared account-parameterized helpers + a thin
`startWhatsApp()` shim. The dedicated test exists and matches the acceptance scenarios.

Note: the repository is a **completed** migration (all 34 steps applied), so two of
Step 17's *temporal* "Must NOT do" constraints have since been legitimately superseded
by later steps (see §4). These are not Step-17 regressions — the Step-17 file itself is
compliant.

## (2) Acceptance-criteria checklist

| Criterion | Result | Evidence |
|-----------|--------|----------|
| `pnpm typecheck` passes (zero errors) | PASS (static, not executed) | All factory imports resolve; signatures align: `handleIncomingMessage(entry,…)`, `handleGroupParticipantsUpdate(ctx,…)`, `getGroupContext(ctx,…)`, `invalidateGroupMetadata(ctx,…)`, `getCachedGroupMetadata(ctx,…)`, connection helpers `(sock, account, …)`. `initWithDbDir` exported from `db.ts`. Types match CONTRACT §5. (Not run per task rules.) |
| Test: 2 distinct folders → 2 entries, 2 distinct `AccountContext`s, 2 distinct auth dirs | PASS | `tests/node/baileys-factory.test.ts` asserts `notStrictEqual(entryA,entryB)`, distinct `ctx`/`messageCache`, both `auth/` dirs created, distinct stubbed sockets. |
| Test: same folder returns same entry (idempotent) | PASS | Third test asserts `strictEqual(second, first)`, socket + ctx reused. Factory early-returns when `entry.sock` is live. |
| Temp folder run confirms `auth/ db/ media/ stickers/` created | PASS | `ensureFolderLayout` test + 4-dir existence checks for both folders. `ensureFolderLayout` `fs.ensureDirSync`s all four. |
| `pnpm dev` (old boot path) still pairs one account | SUPERSEDED / not verifiable | `migration/node/index.ts` is already at Step 28 (WS-server boot); it no longer calls `startWhatsApp()`. The shim still exists and is correct, but the old boot path was retired by a later step. |
| `node --test` green | NOT RUN (task rule) | Test reads as correct and offline (Baileys stubbed via `__setSocketCreatorForTests`). |

## (3) Issues

- [MINOR] `migration/node/db.ts:1122` `initWithDbDir` early-returns when the
  module-global DB handles are already open, and the SQLite handles remain
  module-global. In a real multi-account process the **second** account's
  `initWithDbDir(<folderB>/db)` is a no-op, so both tenants share the **first**
  tenant's `settings/stats/moderation/subagent.db`. This is a per-tenant DB
  isolation gap vs CONTRACT §8. **However Step 17's spec explicitly defers this**
  ("the underlying DB handles remain module-global in this step … genuinely
  independent per-tenant handles are a later step"), so Step 17 is compliant. The
  Step-17 test does not assert DB isolation, so it passes. Flagged for the
  orchestrator to confirm a later step makes the DB handles per-tenant; otherwise
  multi-account DB state leaks in the shipped product.
- [MINOR] `migration/node/wa/connection.ts:633` + `migration/node/wa/index.ts:3`
  `startWhatsApp` is exported/re-exported but no longer called by the live boot
  (`index.ts` now starts the WS server). Harmless dead code left by the topology
  flip; not a Step-17 defect.
- [MINOR] `migration/node/account/baileysFactory.ts:251` reconnect sets
  `entry.sock = undefined` then `await`s `buildSocket` rebuild; during that window
  `account.sock` still references the old (closed) socket. This mirrors the
  original `connection.js` recursive-reconnect behavior (no regression). Old
  socket listeners are dropped with the discarded socket (new `makeWASocket` per
  reconnect), matching the original — no listener leak introduced.

No BLOCKER or MAJOR defects found in the Step-17 file itself.

## (4) "Must NOT do" / isolation / contract notes

- "Do not start the WS server or change `index.ts` boot (Step 20/28)":
  `baileysFactory.ts` itself does NOT start a WS server (scope-correct). `index.ts`
  HAS been changed to a WS-server boot, but that is Step 28's work in this
  completed migration — not attributable to the Step-17 file.
- "Do not delete the global `getSock()` shim yet": `getSock`/`setSockAccessor` are
  GONE from `migration/node` (replaced by per-account `ctx.sock`, per Step 33
  comments). Diverges from Step 17's temporal constraint but is a legitimate
  later-step change; socket access is now correctly per-account via `ctx.sock`.
- "Do not move per-tenant DB wiring into Python here": respected — only Node's
  `initWithDbDir` was added.
- Contract conformance (CONTRACT §5/§8): `AccountEntry`, `BaileysFactoryOptions`,
  `WaStatus` in `protocol/types.ts` match §5 verbatim. `ensureFolderLayout`
  creates exactly `auth/ db/ media/ stickers/` under `folderPath` (§8). DB paths
  resolved under `<folderPath>/db/*.db` (§8). `connection.update` close path
  forwards `whatsapp_status` exactly once via `eventForwarder.forwardStatus`
  (reliable, with optional numeric `reason`), open path once; `connecting` is not
  forwarded — matching the original's open/close-only behavior (forwarding is
  Step 18's domain). Per-account state (caches, counters, senderRef registry,
  pendingForms, `sock`) is isolated on `AccountContext`; the factory reuses an
  existing populated ctx and never shares mutable maps across tenants.
