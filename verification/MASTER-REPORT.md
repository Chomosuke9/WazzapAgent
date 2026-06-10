# WazzapAgents Migration — Master Verification Report

**Date:** 2026-06-10
**Method:** 34 independent read-only verification agents (one per step), each comparing the
implemented code under `migration/` against its `steps/step-NN-*.md` spec and `CONTRACT.md`.
No files were modified. Per-step detail lives in `verification/step-NN-report.md`.
Global gates were run once, centrally (not by the parallel agents, to avoid multi-process hangs).

---

## Bottom line

The migration is **functionally complete and the build is green with zero regressions vs the
documented baseline**. 30 of 34 steps are ACCURATE; 4 are PARTIAL. There are **3 real defects**
worth fixing (1 functional bug, 1 multi-tenant isolation leak, 1 docs/acceptance violation) plus
a handful of minor cosmetic/scope notes. None block the build or break single-account runtime.

| Verdict | Count | Steps |
|---|---|---|
| ACCURATE | 30 | 01–06, 08–12, 14–32 |
| PARTIAL | 4 | 07, 13, 33, 34 |
| INACCURATE | 0 | — |

---

## Central gate results (run under hard timeouts)

| Gate | Result | Notes |
|---|---|---|
| `pnpm typecheck` (`tsc --noEmit`) | **PASS** (exit 0, 0 errors) | Entire `migration/node` is valid TypeScript. |
| `node --test` (all suites) | exit 1 — **baseline only** | Only the 3 pre-existing `tests/node/broadcast.test.mjs` failures (reconstructAndSend / linkPreview / plain-text sendMessage), which import the **untouched original** `src/wa/command/broadcast.js`. No new failures. |
| `pytest migration/python/tests/` | 20 failed / 372 passed — **baseline only** | The exact 20 pre-existing failures: `test_webhook_queue` ×10 (aiohttp not installed), `test_db_resilience` ×2, `test_invalidate_chat_caches` ×1, `test_subagent_tracker_context` ×3 (prompt wording), `test_tool_calls_and_permissions` ×4 (tool-schema counts). No new failures. |

**Conclusion:** the migration introduces **zero regressions** relative to the original trees.

---

## Prioritized bug list

### MAJOR — recommend fixing

1. **Interactive model-config menu buttons silently fail** — `migration/node/wa/connection.ts:386-401`
   (Step 13). `handleButtonResponse` builds the command context for button→slash-command dispatch
   **without `sock`**. The later refactor (Step 33) removed the global `getSock()` and made handlers
   read `ctx.sock`; here `sock` is `undefined`, so the handler throws and the error is swallowed by the
   surrounding try/catch. Result: tapping a `/modelcfg edit|default <id>` menu row does nothing.
   Sibling call sites (`baileysFactory.ts`, `runCommand.ts`) correctly pass `sock`. **Fix:** thread the
   account's `sock`/`ctx` into the context built in `handleButtonResponse`.

2. **Cross-tenant dashboard stats leak** — `migration/python/bridge/dashboard.py:35-44,128-141`
   (Step 33). `_stats_buffer`/`_user_stats_buffer` are module-global and keyed by `chat_id` only (no
   `folder_path`), and `start_flush_loop()` is started once per session (N loops over one shared
   buffer). `flush_to_db` drains the shared buffer to the calling task's ContextVar-resolved
   `stats.db`, so tenant B's stats can be written into tenant A's `stats.db` (and racily lost). This
   contradicts the Step 33 "no cross-talk" acceptance language (note: `settings.db` itself **is**
   correctly isolated via the ContextVar `db.py` routing). **Fix:** key the buffers by
   `(folder_path, chat_id)` and flush per-tenant, or make the buffer an `AgentSession` instance attr.

3. **`.env.example` dropped `LLM_WS_ENDPOINT` instead of deprecating it** — `.env.example` (Step 34).
   Acceptance criterion #2 (`grep "deprecated" .env.example` must flag the key) FAILS, and the step's
   explicit "Must NOT do: do not remove `LLM_WS_ENDPOINT` from `.env.example`" is violated. Confirmed
   via git: the key existed in the Init commit and is now absent. **Fix:** re-add the key with a
   `# deprecated (legacy topology)` comment rather than deleting it.

### MINOR — cosmetic / latent / out-of-scope-by-design

- **Per-chat cache leak if two tenants share a group JID** — `migration/python/bridge/db.py`
  in-memory caches (`_prompt_cache`, `_permission_cache`, `_mode_cache`, `_triggers_cache`,
  `_subagent_enabled_cache`, `_llm2_model_cache`, `_mute_cache`) are module-global keyed by `chat_id`
  only. DB reads/writes stay per-tenant; only the cache layer can cross-read, and it self-heals on the
  next invalidate event. Low impact, but worth keying by tenant.
- **`transport.py` import-floor mismatch** — `migration/python/wasocket/transport.py:39` uses
  `websockets.asyncio.client` (needs `websockets>=13`) while `requirements.txt` pins `websockets>=12`.
  A clean install on 12.x would `ImportError`. **Fix:** bump the pin to `>=13`.
- **No `hello_ack`/handshake recv timeout** — `transport.py` `connect()` awaits `hello_ack` with no
  timeout; a silent server that accepts the socket but never acks would hang the connect (still
  cancellable via `close()`). Consider `asyncio.wait_for`.
- **`socket.py disconnect()` doesn't `reject_all` pending acks** (Step 27) — in-flight awaited actions
  wait out the 30s ack timeout instead of failing fast on disconnect; `PendingAcks.reject_all` is
  effectively dead code. Not a contract violation.
- **Dead code:** `eventForwarder.ts bindForwarder` factory (Step 18), `connection.ts startWhatsApp`
  shim (Step 17), `events.py camel_to_snake` (Step 24) — unused, harmless.
- **Stale comments / spec typos:** misleading ctx-first comment in `actionDispatcher.ts:17-19`;
  `ambient.d.ts` "sticker.js" vs `.ts`; several step files reference pre-migration paths
  (`src/...`, `python.bridge.main`) or the deprecated topology in acceptance one-liners.
- **`AGENTS.md`** build-commands still say `python -m python.bridge.main` (should be
  `python -m bridge.main` from `migration/python`).

---

## Recurring theme (explains most "Must NOT do" notes)

The repo is a **single cumulative final-state snapshot** (only ~3 git commits, no per-step history).
Many steps' "Must NOT do" constraints were boundary rules meant to defer a change to a later step
(e.g. "don't add `AccountContext` yet — Step 16 owns that", "don't add `wsListenPort` yet"). In the
final tree those later steps (16/17/21/28/30/33) are already layered on, so an early step's file
legitimately contains changes its own spec said to defer. The agents flagged these for transparency,
but in every such case the **end state is correct and internally consistent** — they are sequencing
artifacts, not defects.

---

## Per-step verdict index

| Step | Verdict | Headline |
|---|---|---|
| 01 delete-dead-code | ACCURATE | `commands.py` absent + unreferenced in migration tree |
| 02 dead-reference-audit | ACCURATE | no imports of deleted module; all files AST-parse |
| 03 tsconfig-setup | ACCURATE | NodeNext/strict/allowJs/noEmit exact; deps pinned |
| 04 ts-test-runner | ACCURATE | test glob covers .mjs+.ts; ambient `node-webpmux` shim |
| 05 ts-logger-config | ACCURATE | typed logger + Config interface, no issues |
| 06 ts-caches-identifiers | ACCURATE | senderRef/contextMsgId logic byte-identical |
| 07 ts-parsing-media | PARTIAL | correct end state; `setSockAccessor` removed earlier than spec'd |
| 08 ts-db | ACCURATE | db.ts byte-equivalent to src/db.js; `initWithDbDir` additive |
| 09 protocol-types | ACCURATE | types.ts == CONTRACT §5/§7 verbatim |
| 10 ts-wa-leaves | ACCURATE | interactive/sendQueue/utils typed, proto unchanged |
| 11 ts-commands | ACCURATE | all 30 command modules typed, aliases preserved |
| 12 ts-wa-consumers | ACCURATE | outbound/inbound/events/actions/moderation typed |
| 13 ts-orchestrators | **PARTIAL** | **MAJOR: button dispatch missing `sock`** |
| 14 ts-wsclient-index | ACCURATE | superseded by 28/30 (wsClient removed) — by design |
| 15 account-registry | ACCURATE | reliable queue + isolation correct |
| 16 account-context | ACCURATE | per-account fresh state; isolation verified by test |
| 17 baileys-factory | ACCURATE | per-tenant socket/dirs/DB; note: DB-handle isolation deferred |
| 18 event-forwarder | ACCURATE | folderPath stamping + reliable/best-effort correct |
| 19 action-dispatcher | ACCURATE | verbatim port of dispatchCommand, ctx-parameterized |
| 20 ws-server | ACCURATE | handshake/auth/heartbeat/teardown correct |
| 21 route-control-events | ACCURATE | 10 handlers route top-level folderPath frames |
| 22 wasocket-errors | ACCURATE | 6 codes == CONTRACT §2; dependency-free |
| 23 wasocket-protocol | ACCURATE | 23 dataclasses, encode/decode round-trip verified |
| 24 wasocket-events | ACCURATE | WhatsAppMessage == CONTRACT §7 (34 fields) |
| 25 wasocket-correlation | ACCURATE | requestId format + ack future/timeout correct |
| 26 wasocket-transport | ACCURATE | reconnect backoff exact port; see MINOR import pin |
| 27 wasocket-socket | ACCURATE | WaSocket lifecycle/actions == CONTRACT §4 |
| 28 ws-server-flip | ACCURATE | atomic flip clean; old topology fully removed |
| 29 hydration-reconcile | ACCURATE | ack hydration re-homed verbatim, fully tested |
| 30 delete-wsclient | ACCURATE | wsClient gone; `git grep wsClient` in node = 0 |
| 31 trim-python-server | ACCURATE | server helpers removed; `websockets` dep kept |
| 32 per-account-agent-session | ACCURATE | all per-account state as instance attrs; isolation tested |
| 33 multi-account-boot | **PARTIAL** | accounts/db isolation good; **MAJOR: dashboard stats leak** |
| 34 docs-env-e2e | **PARTIAL** | docs+e2e good; **MAJOR: `.env.example` LLM_WS_ENDPOINT deleted** |
