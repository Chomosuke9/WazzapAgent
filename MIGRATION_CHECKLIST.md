# Migration Deliverables Checklist

## Core Documentation

- [x] **CONTRACT.md** (project root, 805 lines)
  - 8 mandated sections: WS Protocol, Error Codes, request_id, WaSocket Interface, TS Types, Python Dataclasses, WhatsAppMessage Fields, Folder Layout
  - Single source of truth for all wire shapes, types, and interfaces
  - Key decisions locked: WaStatus, control events, per-tenant DBs, request_id format

- [x] **MIGRATION_PLAN.md** (reference document, unchanged)
  - High-level phases 0–6 (35 steps planned, 34 final)
  - Diagrams and architecture context preserved

## Migration Execution Model

- [x] **MIGRATION_EXECUTION_NOTES.md** (project root)
  - Overview of `/migration` directory model
  - Why this approach (safety, reference, atomicity)

- [x] **MIGRATION_README.md** (project root, 134 lines)
  - Comprehensive execution guide
  - Directory structure during migration
  - Working procedures and testing strategy
  - Pre-cutover and cutover instructions

- [x] **CORRECTION_SUMMARY.md** (project root, 119 lines)
  - Summary of changes made to support `/migration` approach
  - Verification that all paths updated correctly
  - Key decisions preserved
  - Rollback safety guarantees

## Step Files (34 total)

All step files located in `steps/` directory and updated for `/migration` paths.

### Phase 0 — Cleanup (Steps 01–02)
- [x] **step-01-delete-dead-code.md** — Delete `migration/python/bridge/commands.py`
- [x] **step-02-dead-reference-audit.md** — Audit and clean remaining dead references

### Phase 1 — TypeScript Toolchain (Steps 03–04)
- [x] **step-03-tsconfig-setup.md** — TS toolchain (`tsconfig.json`, `package.json`)
- [x] **step-04-ts-test-runner.md** — Ambient types, test runner

### Phase 2 — JS→TS Conversion (Steps 05–14)
- [x] **step-05-ts-logger-config.md** — `logger.ts`, `config.ts`
- [x] **step-06-ts-caches-identifiers.md** — `caches.ts`, `identifiers.ts`
- [x] **step-07-ts-parsing-media.md** — `messageParser.ts`, `participants.ts`, `mediaHandler.ts`, `groupContext.ts`
- [x] **step-08-ts-db.ts** — `db.ts`
- [x] **step-09-protocol-types.md** — `src/protocol/types.ts` (implements CONTRACT.md §5)
- [x] **step-10-ts-wa-leaves.md** — `wa/utils.ts`, `wa/sendQueue.ts`, `wa/interactive/`
- [x] **step-11-ts-commands.md** — `wa/command/*.ts` (parseCommand + 28 handlers)
- [x] **step-12-ts-wa-consumers.md** — `wa/{actions,moderation,presence,runCommand,outbound,events,inbound}.ts`
- [x] **step-13-ts-orchestrators.md** — `wa/commandHandler.ts`, `wa/connection.ts`, `wa/index.ts`
- [x] **step-14-ts-wsclient-index.md** — `wsClient.ts`, `index.ts` (Phase 2 complete)

### Phase 3 — Node Multi-account + WS Server (Steps 15–21)
- [x] **step-15-account-registry.md** — `src/server/accountRegistry.ts`
- [x] **step-16-account-context.md** — `src/account/accountContext.ts` (D2 atomic step)
- [x] **step-17-baileys-factory.md** — `src/account/baileysFactory.ts` (per-tenant db/ layout per CONTRACT §8)
- [x] **step-18-event-forwarder.md** — `src/account/eventForwarder.ts` (normalizes WaStatus)
- [x] **step-19-action-dispatcher.md** — `src/account/actionDispatcher.ts`
- [x] **step-20-ws-server.md** — `src/server/wsServer.ts` (hello/hello_ack handshake)
- [x] **step-21-route-control-events.md** — Per-account control event routing

### Phase 4 — Python WaSocket SDK (Steps 22–27)
- [x] **step-22-wasocket-errors.py** — Error hierarchy (CODE_TO_CLASS mapping)
- [x] **step-23-wasocket-protocol.md** — Frozen dataclasses (implements CONTRACT.md §6)
- [x] **step-24-wasocket-events.md** — Event constants + `WhatsAppMessage` dataclass (CONTRACT.md §7)
- [x] **step-25-wasocket-correlation.md** — `make_request_id`, `PendingAcks` (CONTRACT.md §3)
- [x] **step-26-wasocket-transport.md** — Port `wsClient` backoff/heartbeat/reliable-queue to Python
- [x] **step-27-wasocket-socket.md** — Public `WaSocket` API (CONTRACT.md §4) + `__init__.py`

### Phase 5 — Topology Reversal + Cleanup (Steps 28–31)
- [x] **step-28-ws-server-flip.md** — **ATOMIC cutover** (Node server + Python client)
  - Includes mandatory extra sections: **Behaviors that break**, **Rollback procedure**, **Verification before merging**
- [x] **step-29-hydration-reconcile.md** — D3 action_ack-as-event for provisional history (merges atomically with Step 28)
- [x] **step-30-delete-wsclient.md** — Delete `migration/node/wsClient.ts`
- [x] **step-31-trim-python-server.md** — Trim Python server dependency surface

### Phase 6 — Multi-account Finalization (Steps 32–34)
- [x] **step-32-per-account-agent-session.md** — Per-account `AgentSession` (Python state isolation)
- [x] **step-33-multi-account-boot.md** — Multi-account entrypoint + per-tenant DB wiring
  - Includes `python/bridge/accounts.py` config loader
  - Wires per-tenant DB paths under `<folder_path>/db/` (CONTRACT.md §8)
  - Confirms Node `getSock()` fully removed
- [x] **step-34-docs-env-e2e.md** — Docs/env/e2e
  - Update `README.md`, `AGENTS.md`, `.env.example`
  - Add `WS_LISTEN_PORT` and `NODE_URL` keys
  - Mark `LLM_WS_ENDPOINT` **deprecated**
  - Two-account e2e smoke test

## Key Contracts Locked

### CONTRACT.md (Single Source of Truth)
- **§1 — WS Protocol:** Full frame definitions (hello, actions, acks, control events)
- **§2 — Error Codes:** 6 stable codes (not_found, permission_denied, etc.)
- **§3 — request_id Format:** `<tag>-<unix_ms>-<seq6>`, 30s expiry, Python-generated
- **§4 — WaSocket Interface:** Python SDK contract (constructor, async methods, events)
- **§5 — TypeScript Types:** Every frame type + `AccountEntry` + `BaileysFactoryOptions`
- **§6 — Python Dataclasses:** Frozen dataclasses for every action/event
- **§7 — WhatsAppMessage Fields:** Canonical inbound model (always/optional marked)
- **§8 — Folder Layout:** Per-tenant `<folder_path>/db/`, per-account auth/media/stickers (SUPERSEDES MIGRATION_PLAN.md D2)

### Critical Decisions
- ✅ **WaStatus normalization:** `open|connecting|close` (Node normalizes Baileys `closed`→`close`)
- ✅ **Control events:** Top-level shape with `folderPath` at top level
- ✅ **Per-tenant DBs:** Each account owns `<folder_path>/db/` with `settings.db`, `stats.db`, etc. (CONTRACT.md §8)
- ✅ **SDK acks:** Action methods `await` ack + return `result`; acks also re-emitted as events (option b hydration)
- ✅ **WhatsAppMessage collision:** SDK's inbound model (`wasocket/events.py`) ≠ agent's history model (intentional separation)

## Testing & Verification

Each step includes **mechanical acceptance criteria** (checkable by command/output, not subjective):
- ✅ TypeScript: `pnpm typecheck` passes
- ✅ Tests: `node --test` and `pytest` pass
- ✅ Runtime: `pnpm dev` boots without error
- ✅ Imports: `grep` confirms dead code removed
- ✅ Per-tenant DBs: two-account boot writes to separate tenant `db/` directories

## Rollback & Safety

- ✅ Original code in `src/`, `python/bridge/` remains untouched
- ✅ All work in `/migration/` (isolated, reviewable, deletable)
- ✅ Step 28 includes rollback procedure and verification steps
- ✅ Full reference material available during migration

## Migration Status

- [x] **Phase 0–6 planning complete** (34 steps defined)
- [x] **CONTRACT.md finalized** (805 lines, all 8 sections)
- [x] **All step files created** (34 total)
- [x] **All step files updated for `/migration` paths** (verified)
- [x] **Documentation created** (MIGRATION_README.md, MIGRATION_EXECUTION_NOTES.md, CORRECTION_SUMMARY.md)
- [ ] **Execution begins** (Step 01 onward)

---

**Next action:** Begin Step 01 (delete dead code in `/migration/python/bridge/commands.py`).
