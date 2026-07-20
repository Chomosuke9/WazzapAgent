# 01 - Runtime Flow

> See `00-overview.md` for the topology and `CONTRACT.md` §1 for the wire
> protocol. Reversed topology: **Node is the WS server**, each **Python
> `WaSocket` is a client** that dials it.

## A. Startup flow

1. **Start the Node gateway first** (it is the server) — `src/index.ts`:
   - Load config (`src/config.ts`): `WS_BIND_HOST`/`WS_LISTEN_PORT`,
     `LLM_WS_TOKEN`, dirs, DB paths.
   - Open the default tenant's persistence (`account/baileysFactory.ts`
     `openAccountPersistence` → `db/Database.ts`): per-tenant
     `settings.db`/`stats.db`/`moderation.db`/`subagent.db` under
     `<dataDir>/db` (WAL mode, tables created if missing).
   - Start the WS server (`server/wsServer.ts`) bound to
     `WS_BIND_HOST:WS_LISTEN_PORT`. Per-tenant Baileys sockets are NOT created
     yet — they are created/resumed lazily on each tenant's first `hello`.

2. **Then start the Python bridge** (the dialing clients) — `python -m bridge.main`:
   - Load accounts (`bridge/accounts.py`): `ACCOUNTS_JSON` → `FOLDER_PATHS` →
     single-account fallback (`FOLDER_PATH`/`DATA_DIR`/`data`).
   - For each account build one `WaSocket` (`make_wa_socket(folder_path,
     **ws_transport_options())`) + one `AgentSession`, start its persistent
     sub-agent webhook, and `asyncio.gather` every session's
     connect→run lifecycle until a shutdown signal fires.

3. **Handshake** (per account, CONTRACT.md §1.1):
   - The `WaSocket` dials `NODE_URL` and sends `hello { folderPath,
     protocolVersion: "2.0" }` (reliable, Python→Node).
   - Node's `server/wsServer.ts` validates the first frame is `hello`, calls
     `account/baileysFactory.createOrResumeAccount({ folderPath })` (ensuring the
     tenant folder layout, opening its DB, creating/resuming its Baileys socket,
     wiring its `AccountContext`), replies `hello_ack { folderPath, waStatus }`,
     then binds the client in the registry and flushes that account's reliable
     queue.
   - On **reconnect** the client re-sends `hello`; Node rebinds it and flushes
     any queued reliable frames.

## B. Incoming message flow (WhatsApp → Node → Python)

1. Baileys emits `messages.upsert` on the tenant's socket. Listeners attached by
   `account/baileysFactory.ts` (`attachCommandListener`, `attachChatbotListener`)
   run against that account's `AccountContext`.
2. **Slash command path** (`attachCommandListener` → `wa/command/CommandRegistry.ts`):
   interactive button/list replies, pending `/modelcfg` form replies, then
   slash-command dispatch. Handled commands set `commandHandled: true`.
3. **Normalization** (`attachChatbotListener` → `wa/inbound.ts`):
   - Unwrap via `wa/domain/messageParser.ts` (text, quoted, mentions, location).
   - Download + persist media via `mediaHandler.saveMedia(..., ctx.mediaDir)`
     into THIS tenant's media dir (CONTRACT.md §8).
   - Assign `contextMsgId` + `senderRef` (`wa/domain/identifiers.ts`).
   - Resolve group metadata/roles (`wa/domain/groupContext.ts`,
     `wa/domain/participants.ts`).
   - Build the `incoming_message` payload.
4. **Node → Python delivery:** forwarded to the tenant's bound client via the
   registry (`eventForwarder.ts` → `sendToClient`, best-effort). Dropped if the
   client is not OPEN; the next burst carries newer state.
5. **Python** receives the frame in the `WaSocket` pump → `AgentSession` routes
   it (`bridge/agent/event_router.py` for control events; the message path for
   `incoming_message`). All DB access is bound to this session's tenant via the
   `_tenant_db_dir` ContextVar set for the whole run.
6. **MuteGate** drops/deletes muted senders before buffering.
7. **BatchProcessor** buffers per chat and debounces
   (`INCOMING_DEBOUNCE_SECONDS`, capped by `INCOMING_BURST_MAX_SECONDS`; skipped
   for private chats and prefix matches).
8. **Trigger filtering** (auto / prefix / hybrid); echo merge folds the bot's own
   echoed messages into provisional history.
9. **LLM1** (`bridge/agent/llm1_router.py`) decides respond / express-only /
   skip (bypassed in DMs; disabled when `LLM1_ENDPOINT` is empty). The idle
   trigger can override a skip.
10. **LLM2** (`bridge/agent/llm2_responder.py`) assembles the prompt + history +
    metadata + permission flags, calls the model (LangChain `ChatOpenAI`), with
    fallback provider on failure.
11. **Action extraction** (`messaging/actions.py`): tool calls →
    `reply_message`, `react_to_message`, `delete_messages`, `mute_member`,
    `kick_members`, `send_quiz`, `send_sticker`, `execute_subtask`, … with
    permission gating (admin status AND chat permission level).
12. **Python → Node actions:** each action is sent over the SAME connection via
    the `WaSocket` SDK (`messaging/gateway.py`), carrying a unique `requestId`.
13. **Node dispatch** (`account/actionDispatcher.ts`, one handler per action →
    `wa/outbound.ts`, `wa/actions.ts`, `wa/moderation.ts`, `wa/presence.ts`,
    `wa/interactive/`). `send_message` goes through the per-JID `wa/sendQueue.ts`
    to preserve ordering.
14. **Node → Python ack:** `action_ack` (and `send_ack` for `send_message`), or
    `error` with a stable `code`. `mark_read`/`send_presence` return silently.
15. **Hydration** (`bridge/agent/ack_hydrator.py`): on `action_ack` for
    `send_message`, the provisional history entry's `context_msg_id` is
    hydrated from `pending` to the real value; sub-agent output paths are
    recorded for later `execute_subtask` resolution.

## C. Model switching flow
1. User picks a model from the `/setting` interactive menu (the standalone
   `/model` command was removed — it is fully superseded by `/setting`).
2. **Node** (`wa/commands/setting.ts` model_select handler) writes
   `chat_settings.llm2_model` to the tenant's `settings.db`.
3. **Node → Python** (reliable, via the registry): `set_llm2_model
   { folderPath, chatId, modelId }` (+ `invalidate_llm2_model` as a cache
   clear). Default-model changes emit `invalidate_default_model`.
4. **Python** `event_router` clears the tenant-scoped model cache (keyed by
   `(tenant, chat_id)`; the default-model cache is keyed per tenant) so the next
   LLM2 call re-reads the fresh config.

## D. Dashboard flow
Python buffers per-chat counters and flushes to the tenant's `stats.db` every
60s (`bridge/dashboard.py`); Node's `/dashboard` reads + formats them.

## E. Reset flow
`/reset` → Node emits `clear_history { folderPath, chatId | "global" }`
(reliable). Python's `event_router` clears that chat's (or all chats') history
ring, idle counter, and debounce state. The `contextMsgId` counter lives on the
Node `AccountContext` and is not decremented.

## F. Sub-agent flow
1. LLM2 calls `execute_subtask` (`instruction`, `context_msg_ids`,
   `high_quality`, `confirmation_text`).
2. `SubAgentCoordinator` stages inputs (off the event loop via
   `asyncio.to_thread`) and POSTs to `SUBAGENT_URL` using
   `Authorization: Bearer SUBAGENT_API_TOKEN`, with a per-account
   `callbackUrl` (`SUBAGENT_WEBHOOK_URL`; explicit public ports are preserved,
   with `{port}`/`{index}` placeholders for multi-account routing).
3. The sub-agent runs asynchronously and calls back the webhook on
   progress/queue/completion, authenticating with `SUBAGENT_WEBHOOK_TOKEN` when
   configured (required for non-loopback binds).
4. The webhook server durably records the result. Non-inlined files are copied
   from a verified shared path or streamed from the same `SUBAGENT_URL` origin
   with the API token, size cap, and SHA-256 verification. LLM2 is re-invoked to
   deliver it (with one optional correction re-dispatch); undelivered results
   are replayed after a bridge restart.

## G. Idle trigger flow
Per-chat `/idle <min-max>` in `settings.db`; `bridge/agent/idle_trigger.py`
tracks `idle_msg_count`, reset on each reply. After LLM1 skip (or when LLM1 is
disabled) it promotes the burst to LLM2 with `P = 1/(max - count + 1)` (always
at `count >= max`).

## H. Quiz flow
LLM2 `send_quiz` → Node builds buttons with `id="qz:<label>"` via `relayMessage`
+ `additionalNodes`, tracking the message id in the per-account `quizMessageIds`
set. A tap (or a reply quoting a tracked quiz) is forwarded as a normal
`incoming_message`; LLM2 sees the quiz in history and handles the answer.

## I. Reconnect / failure behavior
- **Node restarts** (server down): every Python `WaSocket` detects the drop (its
  `isAlive` heartbeat), reconnects with exponential backoff + symmetric jitter
  (`WS_RECONNECT_MS` base, `WS_RECONNECT_MAX_MS` cap, `WS_RECONNECT_JITTER_RATIO`
  spread; attempt counter resets only after the socket stays OPEN for a grace
  window), re-sends `hello`, and flushes its bounded reliable queue (max 1000,
  drop-oldest). In-flight outbound actions during downtime are lost.
- **A Python client disconnects:** Node keeps that tenant's Baileys socket ALIVE
  and only unbinds the client (guarded so a stale socket's late close can't
  unbind a freshly-reconnected client). Reliable Node→Python control events queue
  per account on the registry and flush when the client returns.
- **WhatsApp session logged out:** Baileys reports `loggedOut`; Node stops
  reconnecting that account and logs it — delete that tenant's
  `<folder_path>/auth` and restart to re-pair THAT account only.
- **Graceful shutdown:** on SIGINT/SIGTERM Node terminates clients, closes the
  server (bounded by a timeout), and checkpoints + closes every tenant's DB.
