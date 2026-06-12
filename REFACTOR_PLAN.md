# WazzapAgents — Structure & OOP Refactor Plan

> **Purpose.** The WS-topology migration is functionally complete, but an
> architecture audit found that the codebase is dominated by a few god-files
> and one **multi-account correctness bug**. This plan restructures the project
> into clean, object-oriented, per-tenant-isolated modules **without changing
> external behavior or the wire protocol** (`CONTRACT.md` stays the source of
> truth).
>
> This document is the master index. Each `steps/step-NN-*.md` file is a single
> self-contained unit of work, executed **one at a time** by a dedicated
> subagent and reviewed before moving on.

---

## 1. Goals

1. **Fix the multi-account DB isolation bug** (Node `db.ts` shares one set of
   DB handles across all tenants — violates `CONTRACT.md` §8).
2. **Eliminate god-files** by decomposing them into cohesive, single-
   responsibility classes/modules:
   - `python/bridge/session.py` — 3,027 lines, one ~1,600-line function.
   - `node/db.ts` — 2,019 lines, ~12 domains.
   - `python/bridge/db.py` — 1,722 lines, ~6 domains.
3. **One codebase.** Delete the legacy `src/` + `python/` trees; promote
   `migration/` to be the only runtime tree.
4. **Real OOP**: dependency injection over hard-imported module globals;
   instance-scoped per-tenant state; testable collaborators with no live
   socket/LLM required.
5. **Type safety**: remove `any`/`as unknown as` at the wire/socket boundary;
   a typed command registry instead of stringly-typed dispatch.
6. **Close abstraction leaks**: the bridge reaching into the SDK's private
   `ws._transport`; scattered config reads; process-global state that isn't
   tenant-scoped.

### Non-goals (explicitly out of scope)
- Changing the WebSocket wire protocol or `CONTRACT.md`.
- Changing LLM prompts, behavior, or model selection logic.
- Adding new product features.
- Rewriting the WaSocket SDK (it is already well-layered; we only add one
  public seam).

---

## 2. Audit baseline (why each phase exists)

| # | Severity | Finding | Addressed by |
|---|----------|---------|--------------|
| 1 | **Critical** | `node/db.ts` module-global DB handles + `initWithDbDir` early-return → tenant #2 silently shares tenant #1's DBs | Phase 1 (steps 03–05) |
| 2 | High | `session.py` `AgentSession` is a cosmetic shell; all logic in nested closures inside `_register_handlers` | Phase 3 (steps 08–10) |
| 3 | High | `db.ts` 2,019-line monolith mixing ~12 domains | Phase 1 (steps 03–04) |
| 4 | High | Two parallel codebases (`src/`+`python/` vs `migration/`) already diverged; tests target the dead tree | Phase 0 (steps 01–02) |
| 5 | High | Node command dispatch ad-hoc (5 edit-sites, drifted registries, ~28 `as` casts) | Phase 2 (step 06) |
| 6 | Med | `gateway.py` reaches into SDK private `ws._transport`; two duplicate requestId counters | Phase 4 (step 12) |
| 7 | Med | `account/` ↔ `wa/` circular dependency worked around with lazy imports | Phase 2 (step 07) |
| 8 | Med | Config scattered (136 env reads across 25 files; bypasses config modules) | Phase 4 (step 14) |
| 9 | Med | Process-global state not tenant-scoped (`stickers._catalog`, `history._cached_names`); `SUBAGENT_WEBHOOK_URL` dead in multi-account | Phase 4 (step 13) |
| 10 | Low | `sock: any`, `as unknown as`, god-functions, flat node root, prompt duplication, SDK polish | Phases 2–4 |

Verified-good (preserve, do not "fix"): the WaSocket SDK layering; `db.py`'s
ContextVar per-tenant routing + tenant-keyed caches; the Node socket/cache/
identifier per-account threading (`getSock()` already removed, 0 refs);
`accounts.py`/`main.py` multi-account boot + per-account webhook **port** offset.

---

## 3. Target architecture

### 3.1 Repository layout (after Phase 0 cutover)

```
src/                         Node gateway (TypeScript) — was migration/node
python/                      Python bridge + SDK     — was migration/python
data/                        single-account default tenant folder
tests/                       Node tests (*.test.ts)  — Python tests live in python/tests
CONTRACT.md  README.md  AGENTS.md  REFACTOR_PLAN.md  steps/
```

The legacy `src/` (JS) and `python/` trees are **deleted**, not kept as
reference — git history is the reference.

### 3.2 Node target (`src/`)

```
src/
  index.ts                 composition root only (wire everything, no logic)
  config.ts                single config source (all process.env reads here)
  logger.ts
  server/
    WsServer.ts            class: accept clients on WS_LISTEN_PORT, heartbeat
    AccountRegistry.ts     class: bind client ↔ AccountEntry by folderPath
  account/
    AccountEntry.ts        per-tenant aggregate: sock + context + repos +
                           dispatcher + forwarder (owns its lifecycle)
    AccountContext.ts      per-account caches / identifiers / sendQueue
    BaileysFactory.ts      build/resume socket (buildSocket decomposed)
    ActionDispatcher.ts    routeAction decomposed into per-action handlers
    EventForwarder.ts
  db/
    Database.ts            class: owns one tenant's connections (open/recover/
                           migrate/close) — NO module-global handles
    schema/                table creation + migrations
    repositories/          SettingsRepository, StatsRepository,
                           ModerationRepository, ModelRepository,
                           SubagentRepository, ActivationRepository, …
  protocol/
    types.ts               wire types only (no downward reach into account/)
    ports.ts               interfaces that break the account/↔wa/ cycle
  wa/
    domain/                participants, groupContext, messageParser,
                           identifiers, caches (moved off the flat root)
    Connection.ts          handleButtonResponse decomposed
    inbound/outbound/actions/moderation/presence/events/sendQueue
    commands/
      CommandRegistry.ts   typed Map<name, CommandHandler>; aliases declared
                           on the handler (single source, no drift)
      CommandContext.ts    strict typed context (no all-optional + index sig)
      handlers/            one file per command, each implements CommandHandler
    interactive/
```

Per-tenant ownership: `AccountEntry` constructs and owns its `Database`
instances, repositories, `AccountContext`, dispatcher and forwarder. Nothing
account-specific lives at module scope.

### 3.3 Python target (`python/`)

```
python/
  bridge/
    main.py                boot: load accounts → gather one AgentSession each
    accounts.py
    config.py              single config source
    session.py             AgentSession = thin composition root that builds and
                           wires the collaborators below (no business logic)
    agent/                 injectable collaborators (one responsibility each)
      llm1_router.py       Llm1Router
      llm2_responder.py    Llm2Responder (generation only)
      batch_processor.py   BatchProcessor (debounce/burst/prefix-interrupt)
      subagent_coordinator.py  SubAgentCoordinator
      mute_gate.py         MuteGate
      idle_trigger.py      IdleTrigger
      reply_dedup.py       ReplyDedup
      ack_hydrator.py      AckHydrator
      event_router.py      EventRouter (control-event handling)
    media/                 media + sticker resolution (moved off session.py top)
    db/                    per-domain repositories over the shared core
                           (keep the proven per-tenant routing)
    llm/                   llm1, llm2 (gen), prompt (all assembly here), schemas
    messaging/             processing, actions, filtering, moderation,
                           gateway, format
    subagent/
  wasocket/                SDK — unchanged except one public request_id seam
```

`AgentSession` holds collaborators as instance attributes built in `__init__`
with explicit dependencies (sock, repos, config). Each collaborator is unit-
testable with fakes; no logic lives in nested closures.

---

## 4. Phases & steps

Execute strictly in order. Each step is one subagent.

### Phase 0 — One codebase (cutover)
- **step-01** — Delete legacy `src/` + `python/` + deprecated example; repoint build/tests off the dead tree.
- **step-02** — Physical cutover: `migration/node → src`, `migration/python → python`; fix all path config; green gates.

### Phase 1 — Node DB isolation + repository OOP (fixes the critical bug)
- **step-03** — Extract a `Database` class + `db/schema` from `db.ts` (structural split, no behavior change).
- **step-04** — Split domain accessors into repository classes taking an injected `Database`.
- **step-05** — Make repositories per-account (owned by `AccountEntry`); remove module-global handles + the `initWithDbDir` early-return; add a two-account isolation test.

### Phase 2 — Node command registry + layering + types
- **step-06** — Typed `CommandRegistry` + strict `CommandContext`; delete the switch + alias drift.
- **step-07** — Break the `account/↔wa/` cycle (ports/interfaces, no lazy imports); type the Baileys `sock`; decompose the remaining god-functions.

### Phase 3 — Python bridge OOP decomposition
- **step-08** — Extract low-risk pure collaborators (`MuteGate`, `IdleTrigger`, `ReplyDedup`) + a `media/` module; introduce DI seams in `AgentSession`.
- **step-09** — Extract the LLM pipeline (`Llm1Router`, `Llm2Responder`); consolidate prompt assembly into `llm/prompt.py`.
- **step-10** — Extract `BatchProcessor`, `EventRouter`, `AckHydrator`, `SubAgentCoordinator`; reduce `AgentSession` to a composition root; add collaborator unit tests.
- **step-11** — Split `db.py` into per-domain repositories over the shared core (keep per-tenant routing).

### Phase 4 — Seam, tenant-global cleanup, config, docs
- **step-12** — SDK: optional caller-supplied `request_id` (+ `relay_lottie_sticker` method); remove `gateway.py`'s `ws._transport` bypass; unify requestId counters.
- **step-13** — Tenant-scope the remaining process-globals (`stickers` catalog, `history` assistant name); fix `SUBAGENT_WEBHOOK_URL` in the multi-account path.
- **step-14** — Centralize config: all env reads behind `config.ts` / `config.py`; `.env.example` is the documented contract.
- **step-15** — Update `AGENTS.md` / `README.md` to the new layout; finalize `wa/domain` foldering; full structure verification.

---

## 5. Execution protocol (read before every step)

1. **Orchestrator + one subagent per step.** Never run steps in parallel.
   Review and verify each subagent's output before dispatching the next.
2. **Behavior-preserving.** No protocol changes, no prompt/behavior changes.
   If a step reveals a needed behavior change, stop and ask.
3. **Small, reviewable diffs.** A structural-split step must not also change
   logic. Keep "move code" and "change code" in separate steps where possible.
4. **Verification gates (run every step, under hard timeouts):**
   - **Node:** `pnpm typecheck` → **0 errors**; full test run under a hard
     external timeout with a node test-timeout:
     `timeout --signal=KILL 180 node --test --test-timeout=30000 --import tsx 'tests/**/*.test.ts'`
     → **no new failures** vs. the baseline recorded at the start of the step;
     `pnpm dev` boots `ws server listening` then is killed.
   - **Python:** `PYTHONPATH=python timeout --signal=KILL 200 <py312> -m pytest python/tests -q`
     → **no new failures** vs. baseline. Interpreter:
     `/home/chomosuke/.pyenv/versions/3.12.13/bin/python` (has pytest). Import
     SDK as `wasocket.*`, bridge as `bridge.*`.
   - **Always** wrap any server/socket/test in `timeout --signal=KILL N`, pass
     `--test-timeout`, tear down sockets/intervals/tasks, and kill orphan
     processes. (A prior server-in-test hang cost hours — do not repeat it.)
5. **Known baseline failures** (NOT regressions; a step is clean if it adds
   none beyond these):
   - Python: ~20 pre-existing env failures (`aiohttp` missing → `webhook_queue`,
     `db_resilience`, `invalidate_chat_caches`, `subagent_tracker_context`
     wording, `tool_calls_and_permissions` schema counts). Re-record after
     step-02 since paths change.
   - Node: the 3 `broadcast` failures came from the legacy `src/broadcast.js`
     and disappear once Phase 0 removes/ports that test.
6. **Each subagent prompt must include:** the exact step file to read; the
   gates above with the timeout discipline; an explicit "Must NOT" scope guard;
   and a requirement to report the final `git status --short`.

---

## 6. Step file template

```
# Step NN — <title>
**Phase:** N · **Risk:** low|med|high · **Depends on:** step-MM

## Goal            one paragraph
## Why             audit finding + file:line evidence
## Changes         concrete edits, file by file
## OOP / target    the class/module shape to land on
## Must NOT        scope guard
## Verification    the gates that must pass
## Done when       objective completion criteria
```
