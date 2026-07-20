# 02 — Modules Map

> Current layout (post-migration). Node is TypeScript under `src/`; Python under
> `python/`. See `AGENTS.md` → "Directory Structure" for the authoritative tree.

## Node side (`src/`, TypeScript — WS SERVER)

### Bootstrap & infrastructure
- `src/index.ts` — Composition root: load config, open the default tenant's DB,
  start the WS server, handle shutdown (terminate clients → bounded server close
  → checkpoint+close every tenant DB).
- `src/config.ts` — Single config source (all `process.env` reads): transport
  (`WS_LISTEN_PORT`, `WS_BIND_HOST`, `WS_MAX_PAYLOAD_BYTES`, `LLM_WS_TOKEN`,
  heartbeat/reconnect), dirs, DB paths, sticker + LLM-reply settings.
- `src/logger.ts` — Structured pino logger.
- `src/mediaHandler.ts` — Media download from Baileys, validation, and the
  per-tenant attachment allowlist (`resolveAllowedAttachmentPath` takes the
  account's media/sticker dirs); `saveMedia(..., mediaDir)` writes inbound media
  into the tenant's dir.

### Server (`src/server/`)
- `wsServer.ts` — Inbound WS server: accept clients, Bearer-token upgrade auth
  (constant-time), `maxPayload`, `isAlive` heartbeat, `hello`/`hello_ack`
  handshake, route action frames to the per-account dispatcher.
- `accountRegistry.ts` — `folder_path → AccountEntry` map; `bindClient` /
  `unbindClient(folderPath, ws?)` (guarded against reconnect races),
  `sendToClient` (best-effort), `sendReliableToClient` + `flushReliableQueue`
  (bounded per-account reliable queue).

### Per-tenant account aggregate (`src/account/`)
- `baileysFactory.ts` — `createOrResumeAccount` / `buildSocket`: ensure folder
  layout (CONTRACT.md §8), open the tenant DB, build the `AccountContext`
  (incl. per-tenant media dirs via `resolveTenantMediaDirs`), create the Baileys
  socket, attach listeners. Owns reconnect.
- `accountContext.ts` — Per-account state holder: socket, forwarder, repos,
  per-tenant media/sticker dirs, caches, `contextMsgId` counter, senderRef
  registry, quiz-id set, send queues, pending forms. One per `folder_path`.
- `actionDispatcher.ts` — Dispatch Python→Node actions (one handler per action;
  emits `action_ack`/`error`).
- `eventForwarder.ts` — Forward Node→Python events (per-account, via the
  registry).

### Database (`src/db/`)
- `Database.ts` — Owns one tenant's four logical SQLite DBs (settings/stats/
  moderation/subagent). WAL + `busy_timeout` (the single wait-for-lock
  mechanism — no event-loop-blocking retry sleeps), corruption recovery,
  legacy/subagent migrations. No module-global handles.
- `schema/index.ts` — Table creation + migrations.
- `repositories/` — `BaseRepository`, `SettingsRepository`, `StatsRepository`,
  `ModelRepository`, `ActivationRepository`, and `createRepositories(db)` bundle.

### Protocol (`src/protocol/`)
- `types.ts` — Wire types (CONTRACT.md §5): frames, `WaStatus`, `AccountEntry`,
  payloads.
- `ports.ts` — `WaSocketLike` / `AccountForwarder` interfaces (break the
  `account/ ↔ wa/` cycle).

### WhatsApp integration (`src/wa/`)
- `index.ts` — Barrel + concurrency helpers (`withTimeout`, …).
- `domain/` — `caches.ts` (bounded in-memory caches), `identifiers.ts`
  (`contextMsgId`/`senderRef`/quoted resolution), `participants.ts`,
  `groupContext.ts`, `messageParser.ts`.
- `connection.ts` — Button/list response handler, QR print, `/modelcfg` form
  parsing helpers (shared by the factory listeners).
- `inbound.ts` — Normalize inbound → `incoming_message`.
- `outbound.ts` — Send text/media/mentions (per-tenant attachment allowlist).
- `actions.ts` — React / delete wrappers.
- `moderation.ts` — Kick validation chain.
- `runCommand.ts` — Gateway handler for the `run_command` action.
- `sendQueue.ts` — Per-JID send serialization (`withJidQueue`).
- `presence.ts` — Mark read / typing.
- `events.ts` — Synthetic context events (action log, group join, role change).
- `utils.ts` — `semaphore`, `withRetry`, `escapeRegex`.
- `command/` — `CommandRegistry.ts` (Map<name, handler>, aliases on each
  handler), `CommandContext.ts` (strict typed context incl. `account`,
  `folderPath`, `sock`, `repos`).
- `commands/` — One module per slash command (`activate`, `addsticker`,
  `announcement`, `bot-conf`, `broadcast`, `catch`, `dashboard`, `debug`,
  `generate`, `help`, `idle`, `info`, `join`, `modelcfg`,
  `monitor`, `ownerContact`, `permission`, `prompt`, `removesticker`, `reset`,
  `revoke`, `setting`, `sticker`, `subagent`, `trigger`) + `index.ts` /
  `parseCommand.ts` / `configScope.ts`. Sticker handlers write temp/output files
  into the tenant's media/sticker dir (threaded from `ctx.account`).
- `interactive/` — `sendInteractive.ts` (NativeFlow via `relayMessage` +
  `additionalNodes`), `sendButtons.ts`, `sendCarousel.ts`.

### Other
- `src/utils/` — `cachedAuthState` (per-tenant Baileys auth), stream helpers.
- `src/types/` — ambient TS declarations (`node-webpmux`).

---

## Python side (`python/`)

### WaSocket SDK (`python/wasocket/` — WS CLIENT, CONTRACT.md §4)
- `__init__.py` — re-exports `make_wa_socket`, `WaSocket`, `WhatsAppMessage`.
- `socket.py` — `WaSocket` + `make_wa_socket(folder_path, **transport_options)`;
  typed action methods + `on(event)` decorator; `requestId` correlation seam.
- `transport.py` — `WSClientTransport`: dial `NODE_URL` (sends the
  `Authorization` header when `LLM_WS_TOKEN` is set), reconnect with backoff +
  jitter, `isAlive` heartbeat (`ping_interval=None`), bounded reliable queue.
- `protocol.py` / `events.py` — frame dataclasses (§6) + `WhatsAppMessage` (§7).
- `correlation.py` / `errors.py` — requestId correlation + error hierarchy.

### Bridge core (`python/bridge/`)
- `main.py` — Boot: `load_accounts()` → one `WaSocket` + `AgentSession` per
  account, gathered concurrently; per-account sub-agent webhook; graceful
  shutdown.
- `accounts.py` — Multi-account loader (`ACCOUNTS_JSON` / `FOLDER_PATHS` /
  single-account fallback).
- `session.py` — `AgentSession`: per-account composition root that binds the
  tenant DB/identity ContextVars and wires the `agent/` collaborators.
- `config.py` — Single env-config source (incl. `ws_transport_options()` /
  `ws_auth_headers()`).
- `log.py`, `history.py`, `dashboard.py`, `stickers.py`, `sticker_db.py`
  (per-tenant sticker DB; WAL + `busy_timeout`, no busy-retry sleeps).

### Injectable collaborators (`python/bridge/agent/`)
`llm1_router.py`, `llm2_responder.py`, `batch_processor.py`,
`subagent_coordinator.py`, `mute_gate.py`, `idle_trigger.py`, `reply_dedup.py`,
`ack_hydrator.py`, `event_router.py` — one responsibility each, wired by
`AgentSession`.

### Per-tenant DB (`python/bridge/db/`)
- `core.py` — ContextVar-scoped per-tenant connection routing + tenant-keyed
  caches (`_tenant_cache_key`/`_tenant_key`); WAL + `busy_timeout` (corruption
  recovery only, no busy-retry sleeps).
- `settings_repository.py`, `models_repository.py` (tenant-scoped model caches),
  `moderation_repository.py`, `stats_repository.py`, `activation_repository.py`,
  `__init__.py` (bundle).

### Messaging pipeline (`python/bridge/messaging/`)
`processing.py`, `filtering.py`, `actions.py`, `gateway.py` (sends actions over
the SAME WS via the SDK), `ack_handler.py`, `moderation.py`, `format.py`.

### LLM pipeline (`python/bridge/llm/`)
`llm1.py`, `llm2.py`, `schemas.py`, `prompt.py`, `client.py`, `metadata.py`,
`tool_utils.py`.

### Media + sub-agent
- `media/` — `resolver.py`, `visual.py`.
- `subagent/` — `tracker.py` (durable active/completion recovery), `client.py`,
  `webhook_server.py` (authenticated non-loopback binds and verified streaming
  output downloads), `output.py`
  (tenant-aware input/output staging, basename-sanitized), `config.py`.
- `tools/` — `sticker.py` (PIL), `thumbnail.py`.
