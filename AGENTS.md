# WazzapAgents — Developer Context

> This file is read by AI coding agents at the start of every session. It is the
> canonical reference for understanding this project without rediscovery.

---

## Project Overview

**WazzapAgents** is a WhatsApp AI agent system that connects WhatsApp accounts to
an LLM service, enabling automated conversation, moderation, and interactive
features in group and private chats. Post-migration it supports **multiple
accounts** (tenants), one per `folder_path`, each fully isolated (CONTRACT.md §8).

**Tech stack:**
- **Node.js 18+** (ESM/TS) — WhatsApp gateway via Baileys v7; **WebSocket server**
- **Python 3.10+** — LLM bridge with LangChain / ChatOpenAI; **WaSocket client(s)**
- **SQLite** — per-tenant settings, model configs, moderation state, dashboard stats
- **WebSocket** — Node ↔ Python protocol (JSON over WS, CONTRACT.md §1)

> **Reversed topology (post-migration):** the Node gateway is now the WS
> **server** (binds `WS_LISTEN_PORT`, default `3000`); each Python `WaSocket`
> **client** dials it at `NODE_URL` and announces its tenant `folder_path` in a
> `hello`/`hello_ack` handshake. `CONTRACT.md` is the single source of truth for
> the wire protocol (§1), the `make_wa_socket` SDK (§4), and the per-tenant
> folder layout (§8).

**Architecture at a glance:**

```
  phone A        phone B          ← one WhatsApp account per tenant (per-tenant auth)
     ↕              ↕
┌──────────────────────────────────────────────────────────┐
│  Node.js Gateway — WS SERVER, listens on WS_LISTEN_PORT    │
│  src/  (TypeScript)                                        │
│  ├─ server/   WsServer (accept), AccountRegistry (bind)    │
│  ├─ account/  baileysFactory, accountContext,              │
│  │            actionDispatcher, eventForwarder             │
│  │            (one AccountEntry per folder_path: owns its  │
│  │             Database + repositories, no module globals) │
│  ├─ db/       Database + schema/ + repositories/           │
│  ├─ wa/       domain/ + inbound/outbound/actions/          │
│  │            moderation + command/ (CommandRegistry)      │
│  └─ protocol/ types.ts + ports.ts (wire types, CONTRACT §5)│
└──────────────────────────────────────────────────────────┘
        ▲  hello / hello_ack (§1.1)        ▲
        │  incoming_message, whatsapp_status, control        │  actions (Py→Node):
        │  events, acks  (Node→Python)                       │  send_message, react,
   dial │ NODE_URL                                      dial │  delete, kick, …
┌───────┴────────────────┐                  ┌────────────────┴───────┐
│ Python WaSocket A       │                  │ Python WaSocket B       │
│ folder_path=tenants/a   │                  │ folder_path=tenants/b   │
│  wasocket/ (SDK §4)     │                  │  wasocket/ (SDK §4)     │
│  bridge/ AgentSession   │                  │  bridge/ AgentSession   │
│   = composition root,   │                  │   = composition root,   │
│   wiring agent/ collabs:│                  │   wiring agent/ collabs:│
│  ├─ MuteGate            │                  │  ├─ MuteGate            │
│  ├─ BatchProcessor      │                  │  ├─ BatchProcessor      │
│  ├─ Llm1Router          │                  │  ├─ Llm1Router          │
│  ├─ Llm2Responder       │                  │  ├─ Llm2Responder       │
│  ├─ SubAgentCoordinator │                  │  ├─ SubAgentCoordinator │
│  ├─ ReplyDedup          │                  │  ├─ ReplyDedup          │
│  ├─ IdleTrigger         │                  │  ├─ IdleTrigger         │
│  ├─ AckHydrator         │                  │  ├─ AckHydrator         │
│  └─ EventRouter         │                  │  └─ EventRouter         │
└─────────────────────────┘                  └─────────────────────────┘
 <tenants/a>/{auth,db,media,stickers}   <tenants/b>/{auth,db,media,stickers}
            (CONTRACT §8 — fully isolated per tenant)
```

The bridge loads an accounts list (`bridge/accounts.py`) and runs one
`WaSocket`/`AgentSession` per `folder_path`; a single account is the degenerate
case. `AgentSession` is a thin composition root that builds and wires the
injectable `bridge/agent/` collaborators above (no business logic in nested
closures).

---

## Directory Structure

> **Current layout (post-refactor).** The runtime lives in two top-level trees,
> `src/` (Node gateway, TypeScript) and `python/` (bridge + WaSocket SDK), with
> `data/` as the single-account default tenant folder. The earlier staging tree
> no longer exists — its Node and Python subtrees were promoted to `src/` and
> `python/` as the only runtime. `CONTRACT.md` remains the source of truth for
> the wire protocol and per-tenant folder layout.

```
src/                          Node.js gateway runtime (WS SERVER, TypeScript)
  index.ts                    Composition root: config, ws server, per-tenant accounts (wiring only)
  config.ts                   Single config source — all process.env reads (WS_LISTEN_PORT, dirs, DB paths)
  logger.ts                   Structured pino logger
  mediaHandler.ts             Media download from Baileys, validation, path resolution
  server/
    wsServer.ts               WS server: accept clients on WS_LISTEN_PORT, per-connection heartbeat
    accountRegistry.ts        Bind each client to its folder_path AccountEntry
  account/                    Per-tenant aggregate (one AccountEntry per folder_path)
    baileysFactory.ts         Create/resume the per-tenant Baileys socket + dirs; owns Database + repos
    accountContext.ts         Per-account caches / identifiers / sendQueue / forwarder / repos
    actionDispatcher.ts       Dispatch Python→Node actions for one account (per-action handlers)
    eventForwarder.ts         Forward Node→Python events (per-account reliableQueue)
  db/                         Per-tenant SQLite, NO module-global handles (CONTRACT §8 isolation)
    Database.ts               Class: owns one tenant's connections (open/recover/migrate/close)
    schema/index.ts           Table creation + migrations
    repositories/             Domain repositories over an injected Database:
      BaseRepository.ts       Shared base (connection access, helpers)
      SettingsRepository.ts   Per-chat settings, modes, triggers, prompts, mutes
      StatsRepository.ts      Dashboard stats
      ModelRepository.ts      Per-chat / default LLM2 model config
      ActivationRepository.ts Activation codes / activation state
      index.ts                AccountRepositories bundle + createRepositories(db)
  protocol/
    types.ts                  Wire types (CONTRACT §5): frames, WaStatus, AccountEntry, payloads
    ports.ts                  Interfaces breaking the account/↔wa/ cycle: WaSocketLike, AccountForwarder
  wa/                         WhatsApp modules
    index.ts                  Barrel re-export + concurrency helpers (withTimeout, etc.)
    domain/                   WA-domain primitives (moved off the flat src/ root)
      caches.ts               In-memory bounded caches: groups, messages, participants, quizMessageIds
      identifiers.ts          contextMsgId (6-digit per-chat sequence), senderRef, quoted resolution
      participants.ts         Group role/name caching, owner detection
      groupContext.ts         Group metadata caching + invalidation
      messageParser.ts        Baileys message unwrapping (viewOnce, interactive, buttons)
    connection.ts             Baileys v7 socket lifecycle, QR, button-selection extraction + thin router (delegates to command/ButtonRegistry)
    inbound.ts                Incoming WA → normalized incoming_message payload
    outbound.ts               Send text/media/mentions to WhatsApp
    actions.ts                React / delete message wrappers
    moderation.ts             Kick members from group (validation chain)
    runCommand.ts             Gateway-side handler for Python's run_command action
    sendQueue.ts              Per-JID send queue to preserve WhatsApp message ordering
    presence.ts               Mark read, typing indicator
    events.ts                 Synthetic context events (action log, group join, role change)
    utils.ts                  Concurrency helpers: semaphore, withRetry, escapeRegex
    command/                  Auto-discovered command + button dispatch (no switch, no alias drift)
      CommandRegistry.ts      Map<token, CommandHandler>; auto-discovers commands/ descriptors
      CommandContext.ts       Strict typed context threaded to command handlers (sock, account, repos, …)
      ButtonRegistry.ts       Map<prefix, ButtonHandler>; auto-discovers button handlers from commands/ (longest-prefix match, central activation+permission gate)
      ButtonContext.ts        ButtonHandler descriptor + per-tap context threaded to button handlers
      permission.ts           Shared permission DSL (atoms, parser, validate, describe) used by both registries
    commands/                 Per-command handler modules (a CommandHandler + optional co-located ButtonHandler(s) per file)
      index.ts                Barrel re-export of all handlers + parseSlashCommand
      parseCommand.ts         Raw command text → {command, args} parsing
      activate.ts             /activate <code> — Activate chat with activation code
      addsticker.ts           /addsticker — Add sticker to catalog (static/Lottie)
      announcement.ts         /announcement — Send group announcement (@all)
      broadcast.ts            /broadcast <text> — Broadcast to all groups (owner only)
      catch.ts                /catch — Catch a message for later retrieval
      dashboard.ts            /dashboard — Show chat statistics
      debug.ts                /debug — Show debug info
      generate.ts             /generate <prompt> — Generate image (owner only)
      help.ts                 /help — Show command list
      idle.ts                 /idle <min-max> — Configure idle trigger range
      info.ts                 /info — Show bot info
      join.ts                 /join <link> — Join group via invite link
      memory.ts               /memory — Long-term memory add/delete/list (owner /memory global); mentions kept stable via stored LID
      modelcfg.ts             /modelcfg — Configure default model config
      botConfig.ts (../)      Owner bot-wide config helpers (activation msg, require-activation)
      bot-conf.ts             /bot-conf — Owner-only bot-wide config (activation-msg, prompt-override, require-activation)
      configScope.ts          Shared global|default scope parsing for config commands
      monitor.ts              /monitor — Show dashboard monitor (owner only)
      ownerContact.ts         /owner-contact — Show bot owner contact info
      permission.ts           /permission <level> — Set moderation permission level
      prompt.ts               /prompt <text> — Set per-chat system prompt override
      removesticker.ts        /remove-sticker <name> — Remove sticker from catalog
      reset.ts                /reset — Clear chat memory (/reset global = all chats)
      revoke.ts               /revoke — Revoke activation code(s) from /generate: single id, list (1,2,3), or 'unused' (owner only)
      setting.ts              /setting — Show/edit per-chat settings
      sticker.ts              /sticker [upper#lower] — Create meme sticker (ffmpeg/sharp)
      subagent.ts             /subagent <on|off> — Toggle sub-agent per chat
      trigger.ts              /trigger <type> — Set prefix triggers (tag, tagall, reply, name, join)
    interactive/              Interactive message modules (NativeFlow)
      index.ts                Barrel re-export + sendCopyCode
      sendInteractive.ts      Quick reply, CTA URL, copy, call, combined buttons, list, native flow, rich message (sendRichMessage)
      sendButtons.ts          Legacy proto-based buttons (sendLegacyButtons, sendTemplate)
      sendCarousel.ts         Swipeable carousel cards
  utils/                      Generic Node helpers (cachedAuthState, misc)
  types/                      Ambient TS declarations

python/                       Python bridge + WaSocket SDK (WS CLIENTS)
  wasocket/                   make_wa_socket SDK (CONTRACT §4)
    __init__.py               Re-exports make_wa_socket, WaSocket, WhatsAppMessage
    socket.py                 WaSocket class + make_wa_socket factory (optional caller request_id seam)
    transport.py              WSClientTransport: dial NODE_URL, reconnect, heartbeat
    protocol.py / events.py   Frame dataclasses (§6) + WhatsAppMessage model (§7)
    correlation.py / errors.py requestId correlation + WaSocketError hierarchy (§2/§3)
  bridge/
    main.py                   Boot: load accounts, gather one AgentSession per account
    accounts.py               Multi-account config loader (ACCOUNTS_JSON/FOLDER_PATHS)
    config.py                 Single config source (env reads, debounce/burst constants)
    session.py                AgentSession: thin composition root — builds & wires agent/ collaborators
    log.py                    Structured logging setup
    history.py                WhatsAppMessage dataclass, history formatting (tenant-scoped assistant name)
    dashboard.py              Stats buffer, 60s flush, dashboard text formatting
    stickers.py / sticker_db.py  Sticker catalog scanning + per-tenant sticker DB
    agent/                    Injectable per-account collaborators (one responsibility each)
      llm1_router.py          Llm1Router — decision/gating
      llm2_responder.py       Llm2Responder — response generation only
      batch_processor.py      BatchProcessor — debounce/burst/prefix-interrupt loop
      subagent_coordinator.py SubAgentCoordinator — sub-agent submit/wait/correction/steering
      mute_gate.py            MuteGate — inbound mute enforcement
      idle_trigger.py         IdleTrigger — probabilistic re-engagement
      reply_dedup.py          ReplyDedup — duplicate/near-duplicate reply suppression
      ack_hydrator.py         AckHydrator — hydrate provisional history on action_ack
      event_router.py         EventRouter — control-event (clear_history/invalidate_*) handling
      chat_reinvoker.py       ChatReinvoker — shared "inject a #system turn + re-invoke LLM2 (always responds) + dispatch reply" engine
      scheduled_task_runner.py ScheduledTaskRunner — /schedule-task persistence + one-shot timers (delegates the fire to ChatReinvoker)
      direct_invoke.py        DirectInvokeServer — authenticated HTTP /post endpoint that makes the bot send a message first (re-invokes via ChatReinvoker)
    db/                       Per-domain repositories over the shared per-tenant core
      core.py                 Per-tenant connection routing (ContextVar) + tenant-keyed caches
      settings_repository.py / models_repository.py / moderation_repository.py
      stats_repository.py / activation_repository.py
      __init__.py             Repository bundle assembly
    media/                    Media + sticker resolution (moved off session.py)
      resolver.py             Resolve context_msg_id media paths for tool input
      visual.py               Visual attachment processing (base64, size limits)
    llm/                      LLM pipeline
      llm1.py                 Decision router internals
      llm2.py                 Response generation internals
      schemas.py              Tool schemas (JSON Schema / OpenAI function calling)
      prompt.py               System prompt assembly (all assembly consolidated here)
      client.py               LLM client factory, fallback targets
      metadata.py             Context metadata: bot mention, reply signals, window stats
      tool_utils.py           Cross-provider tool-call extraction
      error_utils.py          LLM error classification / handling helpers
    messaging/                Message processing pipeline
      processing.py           Burst building, payload normalization, dedup, code block extraction
      filtering.py            Trigger check, prefix/trigger mode, echo filtering
      actions.py              Action extraction from LLM2 tool calls and text output
      gateway.py              Send action commands over WS to Node (via SDK, no private bypass)
      ack_handler.py          Action-ack routing helper
      moderation.py           Permission checks, moderation payload merge
      format.py               WhatsApp text sanitization (Markdown → WhatsApp bold)
    tools/                    Tool implementations (PIL sticker creation, thumbnails)
    subagent/                 Sub-agent integration (tracker, client, webhook_server, output, config)
  systemprompt.txt            LLM2 system prompt template
  tests/                      Python tests (pytest) — SDK as wasocket.*, bridge as bridge.*

data/                         Single-account default tenant folder (git-ignored)
  auth/                       Baileys multi-file auth state
  db/                         Per-tenant SQLite DBs
  media/                      Downloaded inbound media + staged sub-agent output
  stickers/                   Sticker catalog for LLM2 tool

tests/                        Node tests (*.test.ts) — node/ unit + e2e/ end-to-end
website/                      Docusaurus documentation site (Indonesian + English)
docs/llm-architecture/        Architecture docs for LLM/agent developers
  00-overview.md → 05-state-data-and-db.md
CONTRACT.md  README.md  AGENTS.md
```

---

## Key Concepts & Terminology

| Term | Definition |
|------|-----------|
| **contextMsgId** | A 6-digit per-chat monotonically increasing sequence number (`000000`–`999999`). Used as the canonical message reference across the system instead of WhatsApp's opaque `wamid-*` IDs. Wraps at 999999. |
| **senderRef** | A short, deterministic reference string per sender in each chat (e.g., `u8k2d1`). LLM moderation uses this instead of JIDs. |
| **LLM1** | Decision/gating model. Determines whether the bot should respond, express-only (emoji/sticker), or skip. Also called "the router". Skipped entirely in private chats and prefix mode. |
| **LLM2** | Response generation model. Produces the actual text reply plus tool calls (`reply_message`, `delete_messages`, etc.). Also called "the responder". |
| **burst** | A group of messages collected during the debounce window before processing as a batch. |
| **session** | A WhatsApp session (Baileys multi-file auth stored in `data/auth/`). Deleting this forces re-pairing via QR code. |
| **tool** | A function the LLM can invoke, defined as JSON Schema. Permission-gated: `reply_message`, `react_to_message`, `send_sticker`, `send_quiz` are always available; `delete_messages`, `mute_member`, `kick_members` depend on chat permission level; `execute_subtask` depends on sub-agent being enabled for the chat. |
| **route** | Not a formal concept in this codebase. When you see "routing" it refers to LLM1's decision of whether to respond. |
| **context window** | The rolling history of messages passed to the LLM (capped by `HISTORY_LIMIT`, default 20). |
| **interactive message** | A WhatsApp NativeFlow message (buttons, carousels, lists). Requires special protobuf wrapping and binary XML nodes. |
| **action** | A command from Python to Node via WS: `send_message`, `react_message`, `delete_message`, `kick_member`, `mark_read`, `send_presence`, `send_buttons`, `send_carousel`, `run_command`, `send_quiz`, `send_copy_code`, `relay_lottie_sticker`, `download_media`. |
| **action_ack** | Node's confirmation response to an action, containing `{ requestId, action, ok, detail, result?, code? }`. |
| **sub-agent** | External service (WazzapSubAgents) that handles complex multi-step tasks delegated via `execute_subtask` tool. Uses a persistent webhook server for callbacks. |
| **idle trigger** | Probabilistic trigger based on message count since last bot reply. Configured per-chat via `/idle <min>-<max>`. Bot re-engages with probability `1/(max - count + 1)`. |
| **echo merge** | Bot's own messages echoed back by WhatsApp (`fromMe=true, contextOnly=true`) are merged into provisional history entries to avoid duplicate context. Controlled by `ASSISTANT_ECHO_MERGE_WINDOW_MS`. |

---

## Architecture Decisions (ADRs)

### ADR-1: Why `relayMessage()` with `additionalNodes` instead of `sendMessage()`

WhatsApp interactive messages (NativeFlow) don't render correctly via
`sock.sendMessage()`. The `sendMessage` path routes through
`prepareWAMessageMedia`, which throws "Invalid media type" for
`interactiveMessage` content. Instead, we must:

1. Construct the proto using `generateWAMessageFromContent` with a
   `viewOnceMessage` wrapper (not `viewOnceMessageV2` — Baileys v7 removed
   the `fromObject` helper).
2. Inject binary XML nodes via `additionalNodes` in `relayMessage()`. The
   `biz` node marks the message as a business native flow, and the `bot` node
   adds the AI badge in private chats.

Without these nodes, the message sends but WhatsApp renders it as plain text
or silently drops it.

### ADR-2: Why LLM1 is a separate router instead of a tool call

LLM1 runs on every incoming message burst in group chats. It uses a cheap,
fast model to make a binary decision: respond or skip. Keeping this as a
separate LLM call rather than making it a tool within LLM2 was chosen because:

- **Cost**: Most group messages don't need a full LLM2 response. Running a
  cheap model first saves expensive LLM2 tokens on ~70-80% of messages.
- **Latency**: LLM1 is tuned for sub-2s responses; LLM2 can take 5-20s.
- **Isolation**: LLM1's prompt is specialized for routing (confidence scoring,
  express-only detection). Mixing this into LLM2's system prompt would make
  both harder to tune.

If `LLM1_ENDPOINT` is empty, LLM1 is disabled and all messages go to LLM2.

### ADR-3: Why the sticker pipeline uses Pillow (PIL) instead of ffmpeg-only

The Python sticker tool (`python/bridge/tools/sticker.py`) uses Pillow for
image manipulation (square-padding, text overlay with outline, font rendering)
because:

- **Text rendering**: ffmpeg's `drawtext` filter doesn't support multi-line
  word wrapping with per-line measurement. Pillow's `ImageDraw.textbbox`
  allows precise layout.
- **EXIF metadata**: WhatsApp stickers require a custom EXIF payload
  (`sticker-pack-id`, `sticker-pack-name`) that ffmpeg can't embed correctly.
  The Python code builds this binary TIFF structure manually.
- **The Node sticker path** (`src/wa/command/sticker.ts`) does use ffmpeg for
  animated stickers (video → WebP conversion) and sharp for static resizing.
  Both approaches converge on the same WhatsApp EXIF format.

### ADR-4: Why reliable per-account queueing for state-sync events

The WebSocket connection between Node and Python can drop during reconnection.
Node sends Node→Python frames through the account registry: `sendToClient()`
is best-effort (dropped if that account's client is not OPEN), while
`sendReliableToClient()` enqueues the frame on the per-account `reliableQueue`
(CONTRACT.md §5) and flushes it when that account's client reconnects. The
reliable path is used for events that must not be lost:

- `whatsapp_status` (connection state changes)
- `clear_history` (history invalidation)
- `set_llm2_model` / `invalidate_llm2_model` (model changes)
- `invalidate_default_model`
- `invalidate_chat_settings` (after mode/prompt/permission/trigger/memory change)
- `set_subagent_enabled` (toggle sub-agent per chat)

Regular `incoming_message` events use the best-effort path because they're
transient — the next burst will include newer state anyway.

### ADR-5: Why contextMsgId is a per-chat 6-digit counter

WhatsApp's native message IDs (`wamid-...`) are long, opaque strings that are
hard for LLMs to reference and easy to hallucinate. The contextMsgId system
creates a short, predictable, per-chat monotonically increasing counter that
LLMs can reliably use in tool calls like `reply_message(context_msg_id="000125")`.

### ADR-6: Why separate SQLite databases (per-tenant settings/stats/moderation/subagent/stickers)

Per-tenant SQLite is split into five databases (one set per tenant under
`<folder_path>/db`, CONTRACT.md §8) to avoid locking contention:

- `settings.db` — read-heavy, written by both Node and Python
- `stats.db` — written frequently by Python, read by Node for dashboard
- `moderation.db` — read-heavy, occasional mutes from Python
- `subagent.db` — sub-agent toggle/state (legacy; `subagent_enabled` is mirrored into `settings.db`)
- `stickers.db` — user-managed sticker catalog (scanned by the LLM2 sticker tool)

Each uses `WAL` mode for concurrent reads.

---

## WebSocket Protocol

Reversed topology (CONTRACT.md §1): **Node is the WS server**, each **Python
`WaSocket` is the client**. After the `hello`/`hello_ack` handshake, **actions**
flow Python→Node and **events, control events and acks** flow Node→Python. Every
Node→Python frame carries `folderPath` for tenant routing.
`WaStatus = "open" | "connecting" | "close"`. Guarantees follow CONTRACT.md §1.6
("reliable" = queued + flushed on reconnect; "best-effort" = dropped if not OPEN).

### Handshake (CONTRACT §1.1)

| Type | Direction | Guarantee | Payload |
|------|-----------|-----------|---------|
| `hello` | Python → Node | reliable | `{folderPath, protocolVersion: "2.0"}` |
| `hello_ack` | Node → Python | reliable | `{folderPath, waStatus}` (sent once the account's Baileys socket is created/resumed + client bound) |

### Node → Python (events & control events)

| Type | Guarantee | Description |
|------|-----------|-------------|
| `incoming_message` | best-effort | Normalized WhatsApp message payload (drops if disconnected) |
| `whatsapp_status` | reliable | Connection state changes: `{folderPath, status, reason?, instanceId}` |
| `clear_history` | reliable | After `/reset` — clears history for `chatId` or `"global"` (top-level + `folderPath`) |
| `set_llm2_model` | reliable | Authoritative model change sync: `{folderPath, chatId, modelId}` (top-level) |
| `invalidate_llm2_model` | reliable | Invalidate cached model for `chatId` or `"global"` (top-level) |
| `invalidate_default_model` | reliable | After `/modelcfg` changes: `{folderPath}` (top-level) |
| `invalidate_chat_settings` | reliable | After `/setting` mode change, `/prompt`, `/permission`, `/trigger`, `/idle`, `/announcement`, `/memory` (top-level) |
| `set_subagent_enabled` | reliable | After `/subagent` toggle: `{folderPath, chatId, enabled}` (top-level) |
| `schedule_task` | reliable | After `/schedule-task <nnHnnM> <prompt>`: `{folderPath, chatId, taskId, fireAtMs, prompt}` (top-level). Bridge persists + re-arms; on fire re-invokes LLM2 (always responds, no LLM1). |

| Type | Description |
|------|-------------|
| `send_message` | Send text + optional attachments. `payload: {chatId, text, replyTo?, attachments?}` |
| `react_message` | React with emoji: `{chatId, contextMsgId, emoji}` |
| `delete_message` | Delete by contextMsgId: `{chatId, contextMsgId}` |
| `kick_member` | Kick members: `{chatId, targets[], mode}` |
| `mark_read` | Send read receipt: `{chatId, messageId, participant?}` |
| `send_presence` | Typing indicator: `{chatId, type: "composing"|"paused"}` |
| `run_command` | Execute slash command silently (no WhatsApp echo): `{chatId, command, contextMsgId?}` |
| `send_quiz` | Multiple-choice quiz buttons: `{chatId, question, choices[], footer?, replyTo?}` |
| `send_copy_code` | CTA copy code button: `{chatId, code, displayText?, quotedPreviewText?}` |
| `relay_lottie_sticker` | Relay Lottie sticker from stored JSON: `{chatId, lottiePayload, replyTo?}` |
| `send_buttons` | Generic NativeFlow buttons (legacy): `{chatId, text, buttons[], footer?}` |
| `send_carousel` | Swipeable carousel cards: `{chatId, cards[], text?}` |
| `download_media` | Lazy media (feature 8): fetch attachment bytes on demand for a previously-forwarded message: `{chatId, contextMsgId? | messageId?}` → `action_ack.result` carries `{path, mime, kind, fileName, ...}` (or `not_found` if the source proto was evicted). Inbound forwards attachment metadata only (`path:null, pending:true`); the bridge calls this when it actually needs the bytes (vision / sticker / sub-agent). |

### Node → Python (responses)

| Type | Description |
|------|-------------|
| `action_ack` | Confirmation: `{requestId, action, ok, detail, result?, code?}` |
| `send_ack` | Sent for `send_message` acks (in addition to `action_ack`): `{requestId}` |
| `error` | Error: `{message, detail, code, requestId, action}` |

---

## LLM Tool Schemas

### LLM1 Tools (decision router)

| Tool | Description | Parameters |
|------|-------------|------------|
| `llm_should_response` | Binary decision: respond or skip | `should_response` (bool), `confidence` (0-100), `reason` (string, 2-320 chars) |
| `llm_react` | Express-only emoji reaction | `emoji` (single emoji), `context_msg_id` (6-digit), `confidence`, `reason` |
| `llm_sticker` | Express-only sticker | `sticker_name` (catalog name), `context_msg_id`, `confidence`, `reason` |

### LLM2 Tools (response generation)

| Tool | Availability | Description |
|------|-------------|-------------|
| `reply_message` | Always | Send text reply. Parameters: `context_msg_id` ("none" or 6-digit), `text`, `command` (slash command string or null), `command_context_msg_id` (6-digit or null). The `command` + `command_context_msg_id` pair enables silent slash command execution alongside a text reply. |
| `react_to_message` | Always | React with a single emoji. Parameters: `context_msg_id` (6-digit), `emoji` (single character). |
| `send_sticker` | Always (dynamic) | Send a catalog sticker. `sticker_name` must match an entry in the sticker catalog. |
| `send_quiz` | Always | Send multiple-choice quiz with tappable buttons (2-5 choices). Parameters: `context_msg_id`, `question`, `choices[{label, text}]`, `footer` (null allowed). |
| `delete_messages` | Permission-gated | Delete one or more messages by contextMsgId. Requires `permission_allows_delete`. |
| `mute_member` | Permission-gated | Mute/unmute a member. `duration_minutes` > 0 mutes, 0 unmutes. |
| `kick_members` | Permission-gated | Remove members from group. Cannot kick admins or bot. Parameters: `targets: [{sender_ref}]`. |
| `execute_subtask` | Sub-agent enabled | Delegate complex task to sub-agent. Supports correction re-dispatch (LLM2 can re-invoke with revised instruction). |

---

## Development Conventions

### How to add a new tool

1. **Define the schema** in `python/bridge/llm/schemas.py` — add a JSON Schema
   function definition following the existing pattern (e.g., `REPLY_MESSAGE_TOOL`).
   Set `strict: true` and include all parameters.
2. **Register the tool** — add it to `build_llm2_tools()` in `schemas.py`,
   gated by the appropriate permission flag if it's a moderation tool.
3. **Parse the tool call** — add extraction logic in
   `python/bridge/messaging/actions.py` (`_extract_actions_from_tool_calls`).
   Map the tool call to an action dict with `type`, `chatId`, etc.
4. **Implement the action handler** — in `python/bridge/messaging/gateway.py`,
   add a `send_<action>()` function that sends the action over WS to Node.
5. **Handle the action in Node** — add a per-action handler to the dispatch
   map in `src/account/actionDispatcher.ts` that calls the appropriate
   `src/wa/` module (no central switch — one handler per action).
6. **Update the protocol** — add the action to the README protocol section
   and document `action_ack`/`error` responses.

### How to add a new LLM provider

1. **LLM1**: Set `LLM1_ENDPOINT` to the provider's OpenAI-compatible base URL
   (e.g., `https://openrouter.ai/api/v1`). Both base URL and full URL formats
   (with `/chat/completions`) are accepted — the suffix is stripped automatically
   if present. Set `LLM1_MODEL` and `LLM1_API_KEY`. For fallback, set
   `LLM1_FALLBACK_ENDPOINT/MODEL/API_KEY`.
2. **LLM2**: Same pattern with `LLM2_*` env vars. Both base URL and full URL
   formats are accepted. The bridge uses `ChatOpenAI` from LangChain, so any
   OpenAI-compatible API works.
3. **Custom providers**: If the provider doesn't follow OpenAI's tool call
   schema, add extraction logic in `python/bridge/llm/tool_utils.py`.

### Environment variables

See `.env.example` for the complete reference.

**Transport (reversed topology) — required:**

| Variable | Description |
|----------|-------------|
| `WS_LISTEN_PORT` | Node server listen port (the gateway binds a ws server here). Default `3000`. |
| `NODE_URL` | URL each Python `WaSocket` client dials. Default `ws://localhost:3000`. |

**Accounts / multi-tenant (Python side):**
`ACCOUNTS_JSON` (path to a JSON accounts file; per-account `node_url` overrides
`NODE_URL`), `FOLDER_PATHS` (comma-separated tenant folders sharing `NODE_URL`),
`FOLDER_PATH` (single-account fallback; or `DATA_DIR`, or repo default
`data`). Each tenant folder is `<folder_path>/{auth,db,media,stickers}`
(CONTRACT.md §8). Resolution order: `ACCOUNTS_JSON` → `FOLDER_PATHS` →
single-account fallback.

**Node Gateway:**
`INSTANCE_ID`, `BOT_OWNER_JIDS`, `ASSISTANT_NAME`, `REQUIRE_ACTIVATION`,
`CONTEXT_TIME_UTC_OFFSET_HOURS`, `LLM_WS_TOKEN`,
`WS_BIND_HOST` (host the WS server binds to, default `127.0.0.1` (loopback); set `0.0.0.0` for cross-host + set `LLM_WS_TOKEN`),
`WS_MAX_PAYLOAD_BYTES` (max inbound WS frame size, default 8 MiB),
`DATA_DIR`, `MEDIA_DIR`,
`STICKERS_DIR`, `LOG_LEVEL`,
`LOG_COLOR` (`auto`|`always`|`never`, also honours `NO_COLOR`; shared with the Python bridge),
`BAILEYS_LOG_LEVEL` (level for Baileys' own internal logger, default `warn` to suppress its info chatter; `silent` mutes it),
`WS_RECONNECT_MS`,
`WS_RECONNECT_MAX_MS` (cap for exponential backoff, default 60000),
`WS_RECONNECT_JITTER_RATIO` (+/- jitter fraction 0..1, default 0.2),
`WS_HEARTBEAT_INTERVAL_MS` (ping cadence and detection granularity when connected, default 20000),
`GROUP_METADATA_TIMEOUT_MS`, `DOWNLOAD_TIMEOUT_MS`, `SEND_TIMEOUT_MS`,
`UPSERT_CONCURRENCY`, `PERF_LOG_ENABLED`, `PERF_LOG_THRESHOLD_MS`,
`STALE_MESSAGE_MAX_AGE_MS` (drop messages older than this on reconnect, default 5000ms; `0` disables)

**Sticker creation (Node):**
`STICKER_MAX_DURATION_SEC` (default 6), `STICKER_MAX_SIZE_KB` (default 1024),
`STICKER_FPS` (default 15), `STICKER_QUALITY` (default 75),
`STICKER_PACK_NAME` (default "WazzapAgents"), `STICKER_EMOJI` (default "🤖"),
`STICKER_UPLOAD_DIR` (user-uploaded sticker staging dir, default `<DATA_DIR>/stickers_user`)

**Python Bridge:**
`HISTORY_LIMIT` (default 20), `INCOMING_DEBOUNCE_SECONDS` (default 5),
`INCOMING_BURST_MAX_SECONDS` (default 20), `PROMPT_MAX_CHARS` (default 4000),
`BRIDGE_SLOW_BATCH_LOG_MS` (default 2000), `BRIDGE_MAX_TRIGGER_BATCH_AGE_MS` (default 45000),
`BRIDGE_REPLY_DEDUP_WINDOW_MS` (default 120000), `BRIDGE_REPLY_DEDUP_MIN_CHARS` (default 24),
`BRIDGE_ASSISTANT_ECHO_MERGE_WINDOW_MS` (default 180000),
`BRIDGE_LOG_LEVEL`, `BRIDGE_LOG_PROMPT_FULL`, `BRIDGE_LOG_EXTRAS_LIMIT`,
`BRIDGE_LOG_INFO_EXTRAS`, `BRIDGE_LOG_CHAT_LABEL_WIDTH` (default 18), `BRIDGE_LOG_CHAT_LABEL_DEFAULT`,
`BRIDGE_LOG_QUIET_THIRD_PARTY` (default true — floor noisy libs like httpx/openai/websockets at WARNING)

**LLM1 (Router):**
`LLM1_ENDPOINT`, `LLM1_MODEL`, `LLM1_API_KEY`, `LLM1_FALLBACK_ENDPOINT/MODEL/API_KEY`,
`LLM1_TEMPERATURE`, `LLM1_TIMEOUT`, `LLM1_MAX_TOKENS`, `LLM1_HISTORY_LIMIT`,
`LLM1_MESSAGE_MAX_CHARS`, `LLM1_ENABLE_MEDIA_INPUT`, `LLM1_SDK_MAX_RETRIES`

**LLM2 (Responder):**
`LLM2_ENDPOINT`, `LLM2_MODEL`, `LLM2_API_KEY`, `LLM2_FALLBACK_ENDPOINT/MODEL/API_KEY`,
`LLM2_TEMPERATURE`, `LLM2_TIMEOUT`, `LLM2_RETRY_MAX`, `LLM2_RETRY_BACKOFF_SECONDS`,
`LLM2_SDK_MAX_RETRIES`, `LLM2_MESSAGE_MAX_CHARS`, `LLM2_ENABLE_MEDIA_INPUT`

**LLM Reply Format:**
`LLM_REPLY_INTERACTIVE` (false = plain text via sock.sendMessage, works on WA Web;
true = interactive card via sendRichMessage, mobile only),
`LLM_REPLY_FOOTER` (optional footer appended to every LLM text reply)

**Shared Media:**
`LLM_MEDIA_MAX_ITEMS` (default 2), `LLM_MEDIA_MAX_BYTES` (default 5242880)

**SQLite DB paths (defaults under DATA_DIR):**
`SETTINGS_DB_PATH`, `STATS_DB_PATH`, `MODERATION_DB_PATH`,
`SUBAGENT_DB_PATH`, `STICKERS_DB_PATH`,
`BOT_SETTINGS_DB_PATH`, `BOT_STATS_DB_PATH`, `BOT_MODERATION_DB_PATH`

**SubAgent:**
`SUBAGENT_URL`, `SUBAGENT_WEBHOOK_PORT` (BASE port, default 8081; multi-account:
account N binds `SUBAGENT_WEBHOOK_PORT + N`, index 0 keeps the base so
single-account is unchanged),
`SUBAGENT_WEBHOOK_URL`, `SUBAGENT_WEBHOOK_HOST` (webhook bind host, default `127.0.0.1` (loopback); set `0.0.0.0` only for a remote sub-agent), `SUBAGENT_WAIT_TIMEOUT_S` (default 300),
`SUBAGENT_MAX_WAIT_S` (default 1800), `SUBAGENT_ENABLED_DEFAULT` (default false),
`SUBAGENT_INPUT_STAGING_DIR`, `SUBAGENT_MAX_INLINE_FILE_BYTES`, `SUBAGENT_WEBHOOK_MAX_BODY_BYTES`

**Direct-invoke endpoint (bot-first messaging):**
`DIRECT_INVOKE_API_KEY` (shared secret; the endpoint stays DISABLED until set —
fail-closed), `DIRECT_INVOKE_PORT` (BASE port, default 8090; multi-account:
account N binds `DIRECT_INVOKE_PORT + N`, index 0 keeps the base),
`DIRECT_INVOKE_HOST` (bind host, default `127.0.0.1` (loopback); set `0.0.0.0`
only to reach it from another device, and keep the key secret + firewall it),
`DIRECT_INVOKE_MAX_CHARS` (max `q` length, default `PROMPT_MAX_CHARS`)

### Docker

The project doesn't currently include a Dockerfile. To containerize:

- **Node gateway**: `docker build` with Node 18+, copy source, run `pnpm install && pnpm dev`
- **Python bridge**: `docker build` with Python 3.10+, install requirements, run `python -m bridge.main`
- Mount `data/` as a volume for auth state persistence across restarts.

---

## Known Gotchas & Footguns

### Baileys session state

- **Auth corruption**: If `data/auth/` is partially written during a crash, delete
  the entire directory and re-pair via QR. Never try to fix it manually.
- **Logged out**: If WhatsApp logs out the session (multi-device limit), the
  gateway logs `"Logged out from WhatsApp"` and stops reconnecting. Delete
  `data/auth/` and restart.
- **Pairing phone**: First run prints a QR code. Scan it quickly — it expires
  in ~20 seconds. If missed, restart the gateway.

### Token usage normalization

LLM1 and LLM2 token counts come from different providers with different
tokenizers. The `usage_metadata` from LangChain may report `input_tokens` and
`output_tokens` that don't match OpenAI's billing tokenizer. Don't rely on
these for exact cost calculation.

### Group chat vs DM behavior differences

- **LLM1 is skipped in private chats** — all DMs get a response (confidence 100).
- **Private chats skip debounce** — messages are processed immediately.
- **Group chats** use prefix/hybrid/auto modes set via the `/setting` menu (mode
  section) and the `/trigger` command.
- **Permission tools** (`delete_messages`, `mute_member`, `kick_members`) are
  only available if the bot is an admin in the group.
- **Interactive messages** (`sendRichMessage`, `sendCarousel`, etc.) don't render
  on WhatsApp Web — only mobile clients support `viewOnceMessage` interactive
  content.
- **Mentions** in outbound text use the format `@Name (senderRef)`. The
  `renderOutboundMentions()` function resolves these to actual JIDs. Invalid
  senderRef tokens are silently stripped. Use `@all (all)` to tag everyone in a
  group — this sets `nonJidMentions` in the WhatsApp `contextInfo` instead of
  listing every participant JID individually. Mentions saved by `/memory`
  additionally persist the mentioned person's stable **LID** (in the
  `memory_mentions` table) as the source of truth: on a senderRef registry miss
  `renderOutboundMentions()` re-registers the `senderRef`→JID mapping from that
  stored LID *before* falling back to a (ban-risky) group-metadata refetch — so
  saved mentions keep resolving after a restart or for a participant who hasn't
  spoken, and a display-name change never breaks the tag (the senderRef is
  derived from the JID, not the name).

### WebSocket reconnection

- If the connection drops, the Python `WaSocket` transport
  (`python/wasocket/transport.py`) reconnects with exponential backoff +
  symmetric jitter (`WS_RECONNECT_MS` base, `WS_RECONNECT_MAX_MS` cap,
  `WS_RECONNECT_JITTER_RATIO` +/- spread; the jittered delay is also clamped to
  the cap) and flushes its bounded reliable queue (`hello`) after reconnect. The
  `attempt` counter is reset only after the socket has stayed OPEN for a short
  grace period, so a server that accepts the handshake and kicks immediately
  still sees exponential backoff. On the Node side, the WS server
  (`src/server/wsServer.ts`) runs a per-connection heartbeat using the canonical
  `ws`-docs `isAlive` pattern: a single interval at `WS_HEARTBEAT_INTERVAL_MS`
  is both pinger and reaper, so the interval itself is the detection granularity
  and there is no second timer to race. Reliable Node→Python control events are
  queued per account on the registry (`sendReliableToClient`) and flushed when
  that account's client reconnects. The Python `WaSocket` transport
  (`python/wasocket/transport.py`) mirrors this with its own canonical `isAlive`
  heartbeat at `WS_HEARTBEAT_INTERVAL_MS` (it connects with the `websockets`
  library's built-in `ping_interval=None`, so the SDK's own check-then-ping /
  terminate-on-missed-pong loop is the single source of liveness detection,
  matching the Node server's pattern).
- If Node restarts, every Python client must reconnect. There's no persistent
  queue on the Python side for outbound actions — in-flight batches are lost.

### Message dedup, echo merge, and ordering

- The Python bridge uses a reply dedup window (`BRIDGE_REPLY_DEDUP_WINDOW_MS`,
  default 2 min) with a minimum character threshold (`BRIDGE_REPLY_DEDUP_MIN_CHARS`,
  default 24) to avoid sending duplicate or near-duplicate LLM2 responses.
- `contextMsgId` wraps at `999999`. The system handles this correctly, but
  don't assume it's globally unique — it's only unique within a chat.
- **Echo merge**: Bot's own echoed messages (`fromMe=true, contextOnly=true`)
  are merged into provisional "pending" history entries within
  `ASSISTANT_ECHO_MERGE_WINDOW_MS` (default 3 min). This prevents duplicate
  context entries when WhatsApp echoes the bot's own sent messages back.
- **Provisional history**: Bot-sent messages start with `context_msg_id="pending"`.
  They are hydrated to their real contextMsgId when the `action_ack` arrives
  from Node. This lets the LLM see its own replies in context immediately,
  before the echo arrives.

### Sticker creation gotchas

- Node and Python have **separate** sticker pipelines. Node handles the
  `/sticker` slash command (using `sharp` and `ffmpeg`). Python's
  `tools/sticker.py` handles LLM-initiated sticker creation (using Pillow).
- Both converge on the same output format (512×512 WebP with WhatsApp EXIF
  metadata), but they're independent implementations.
- Animated stickers from video have three fallback quality levels to stay under
  the size limit. If all levels fail, the sticker command returns an error.
- **Lottie/premium stickers**: Captured via `/addsticker` and stored with their
  raw `lottie_payload` JSON. When the LLM sends a sticker whose resolved entry
  has a `lottie_payload`, it is relayed via `relay_lottie_sticker` action instead
  of sending a .webp file. This preserves the full Lottie animation.

### Interactive message rendering

- WhatsApp requires the `viewOnceMessage` wrapper AND binary XML
  `additionalNodes` to render interactive messages. Without either, the message
  silently fails to render or appears as plain text.
- The `badge` parameter in `buildInteractiveNodes()` adds the AI indicator in
  private chats. In groups, it's omitted because only business accounts can
  show badges in group chats.

### Debounce behavior details

- **Private chats**: Debounce is skipped entirely — messages are processed
  immediately (timeout=0).
- **Prefix/Hybrid mode**: If a prefix trigger matches in the pending payloads,
  debounce is skipped so the bot responds instantly.
- **Auto mode**: Standard debounce waits `INCOMING_DEBOUNCE_SECONDS` of quiet
  after the last event, capped at `INCOMING_BURST_MAX_SECONDS` since burst start.
- **Stale batch discarding**: If a batch's age exceeds
  `BRIDGE_MAX_TRIGGER_BATCH_AGE_MS`, it is dropped entirely to prevent
  responding to very old messages after a network blip.

### Hybrid mode prefix interrupt

- In hybrid mode, if LLM1 is running and a prefix-triggered message arrives
  for the same chat, the `prefix_interrupt` event is set, cancelling the
  in-flight LLM1 call. The new batch is merged into the current burst and
  processing proceeds directly to LLM2. This prevents the model from
  unnecessarily running LLM1 when the user has explicitly invoked the bot.

### Mute enforcement (dual layer)

Mute enforcement happens at **two levels**:
1. **Python bridge** (before debounce): When an incoming message arrives, the
   bridge checks if the sender is muted. If so, it sends a `delete_message`
   action back to Node immediately (before the message enters the debounce
   queue) and optionally sends a "Message deleted (muted)" notification.
2. **Node.js** (not yet implemented for inbound mute — only Python side):
   The bridge handles the first-delete notification and remaining minutes.

Messages from muted users are completely invisible to LLM1/LLM2.

### Bot role change notifications

- When the bot is promoted or demoted in a group, the `botrolechange` message
  type triggers automatic responses:
  - **Promoted**: Bot sends "Bot is now an admin! Moderation features can now be enabled."
  - **Demoted**: Bot resets permission to 0, clears all mutes, and sends
    "Bot is no longer an admin. Moderation permissions have been reset."

### Activation gate

- When `REQUIRE_ACTIVATION=true`, all chats must be activated via
  `/activate <code>` before the bot responds. Only `/info` and `/activate`
  commands are exempt. The gate is enforced at two levels:
  1. **Node.js** (`src/wa/command/CommandRegistry.ts`, `dispatchCommand`):
     Blocks non-exempt commands before dispatch.
  2. **Python bridge** (main.py): Drops incoming_message payloads from
     unactivated chats before they enter the debounce/batch pipeline.

### `/dump` command

- The `/dump` command (handled in Python, since it needs full LLM context)
  builds the complete system prompt, group description, chat state, history,
  and current message into a .txt file. It's sent as a document attachment
  via `send_attachment`. The file is written to `MEDIA_DIR/dump_context/`
  to avoid race conditions with /tmp cleanup.

### Direct-invoke endpoint (bot-first messaging)

- `python/bridge/agent/direct_invoke.py` (`DirectInvokeServer`) is a small
  authenticated HTTP server, one per account, that makes the bot **send a
  message first**. Use case: trigger the bot from an external device (e.g. a
  smartwatch) so a WhatsApp notification arrives.
- Request: `GET`/`POST` `/post?q=<prompt>&jid=<chat jid>&key=<api key>`. `q` is
  injected as a **`#system` history turn** (role `system`, rendered as
  `[#system] … SYSTEM: …` by `history.py`), then LLM2 is re-invoked and the
  reply is dispatched to `jid`. A bare phone number for `jid` is normalised to
  `<digits>@s.whatsapp.net`. The key may also be sent via `X-Api-Key` or
  `Authorization: Bearer` (preferred — keeps it out of URLs/logs). Returns
  `202 Accepted`; the LLM call runs in a background task so a slow model never
  blocks the HTTP response.
- The re-invoke itself is the shared `ChatReinvoker` (same engine
  `ScheduledTaskRunner` uses on a timer fire): inject the system turn, call
  `responder.generate(...)` with **no LLM1 gating** (always responds), dispatch
  the actions. `AgentSession._submit_direct_invoke` wraps it in `tenant_db()`
  so the background task runs under the right tenant's DB + assistant identity
  (the aiohttp request task does not inherit `run()`'s ContextVars).
- **Security / fail-closed**: the server does **not** start unless
  `DIRECT_INVOKE_API_KEY` is set, every request is checked with a constant-time
  comparison, it binds `127.0.0.1` by default, and the aiohttp access log is
  disabled so a key passed in the query string is never logged. It can make the
  bot send arbitrary messages, so expose it beyond loopback only behind a
  firewall / reverse proxy. Config: `DIRECT_INVOKE_API_KEY`,
  `DIRECT_INVOKE_PORT` (base; account N binds `base + N`), `DIRECT_INVOKE_HOST`,
  `DIRECT_INVOKE_MAX_CHARS` (see `.env.example`).

### Sub-agent integration

The sub-agent system delegates complex tasks to an external service (WazzapSubAgents):

- **Tool**: `execute_subtask` accepts `instruction`, `confirmation_text`,
  `context_msg_ids` (for media input), `high_quality` flag.
- **Flow**: LLM2 calls `execute_subtask` → bridge submits to sub-agent via HTTP
  → sub-agent processes (potentially minutes) → calls back via webhook → bridge
  re-invokes LLM2 with the result for delivery + optional correction.
- **Webhook server**: Persistent aiohttp server on `SUBAGENT_WEBHOOK_PORT`.
  Auto-restarts on crash. Receives `complete`, `progress`, `queue` callbacks.
- **Correction re-dispatch**: If the sub-agent result is wrong, LLM2 can call
  `execute_subtask` again in the same re-invoke turn to correct it. Only one
  correction level is supported.
- **Steering**: If `execute_subtask` is called while a sub-agent is already
  running for the same chat, the new instruction is forwarded as a "steering"
  signal to the in-flight session instead of spawning a new one.
- **Background task**: The sub-agent wait runs in a background asyncio task so
  the per-chat lock is released. New message bursts are processed normally
  while a sub-agent is running (LLM2 sees the active-task context block).
- **Queue notifications**: Sub-agent queue position updates are forwarded to
  the WhatsApp chat.

### Quiz system

- The `send_quiz` LLM2 tool sends a multiple-choice quiz with quick-reply buttons.
- Quiz buttons use `id="qz:<label>"` format. When tapped, the reply is
  forwarded to Python as plain text.
- `src/wa/domain/caches.ts` exports a `quizMessageIds` Set (bounded to 2000 entries) that
  tracks WhatsApp message IDs of sent quizzes. The Node inbound handler uses
  this set to distinguish quiz button replies (→ forward to LLM) from settings
  menu replies (→ handle locally, suppress LLM).
- The Python bridge maintains a synthetic `[QUESTION SENT]` history entry so
  LLM2 sees its own quiz on the next turn.

### Idle trigger

- Configurable per-chat via `/idle <min>-<max>` (range) or `/idle <N>` (fixed).
- The bridge counts messages since the last bot reply. If the count reaches
  the configured threshold, the bot re-engages with the conversation even
  when no prefix/trigger matches.
- Probability-based for ranges: `P = 1 / (max - count + 1)` when
  `min <= count < max`. Always triggers when `count >= max`.
- Idle trigger can override an LLM1 "skip" decision if the idle count exceeds
  the threshold — the bot jumps in even when LLM1 voted to stay silent.

### Message send queue (JID-level)

- `src/wa/sendQueue.ts` implements `withJidQueue(chatId, fn)` — a per-JID
  serialization queue. All `send_message` actions dispatched in
  `src/account/actionDispatcher.ts` go
  through this to preserve WhatsApp message ordering. Without this, rapid
  sequential sends could arrive out of order because Baileys' socket write
  is async.

### Action ack hydration

- When Node sends an `action_ack` for `send_message`, Python hydrates the
  provisional history entry (changing `context_msg_id` from "pending" to the
  real 6-digit ID). This also triggers storage of sub-agent output file paths
  in `media_paths_by_chat` for subsequent `execute_subtask` resolution.

---

## Build, Test, and Development Commands

- **Install Node deps**: `pnpm install` (Node 18+; project is ESM + TypeScript via `tsx`)
- **Install Python deps**: `pip install -r requirements.txt` (Python 3.10+)
- **Run gateway**: `pnpm dev` (same as `pnpm start`, runs `tsx src/index.ts`) —
  binds the WS server on `WS_LISTEN_PORT` and creates/resumes a Baileys socket per tenant
- **Run Python bridge**: `python -m bridge.main` (dials `NODE_URL` per account)
- **Typecheck**: `pnpm typecheck` (`tsc --noEmit`) → must be 0 errors
- **Lint**: `pnpm lint` (currently placeholder)
- **Node tests**: `pnpm test` (`node --test --import tsx 'tests/**/*.test.ts'`) —
  unit (`tests/node/`) + end-to-end (`tests/e2e/`); a scripted `stub_node_server`
  drives the SDK handshake. Wrap any socket/server test in `timeout --signal=KILL N`.
- **Python tests**: `PYTHONPATH=python python -m pytest python/tests -q` —
  import the SDK as `wasocket.*` and the bridge as `bridge.*`.

## Coding Style & Naming Conventions

- **Language**: TypeScript on the Node side (ESM, Node ≥18) and Python 3.10+ on
  the bridge. Prefer async/await, top-level imports.
- **Formatting**: 2-space indentation, single quotes, no trailing commas (TS/JS).
  Python follows PEP 8 with the existing project style.
- **Logging**: Use `logger` from `src/logger.ts` (Node) or `bridge/log.py` (Python).
  Prefer structured context objects over string interpolation.
- **Paths in payloads**: Stay workspace-relative (`data/media/...`) as shown in README.
- **Naming**: camelCase in JS, snake_case in Python. Don't mix within the same file.
- **Error handling**: Async functions must propagate errors explicitly or catch and
  log. Never silently swallow errors.

## Commit & Pull Request Guidelines

- **Commit messages**: Imperative mood, short prefix (`add`, `fix`, `refactor`).
  If changing protocol, mention `protocol:` in subject.
- **PRs**: Include summary of changes, testing performed (`pnpm dev` smoke test),
  and notes on protocol/schema changes (e.g., new payload fields).
- **Screenshots/logs**: Only when QR flow or UI is affected.

## Security

- Never commit `data/auth/`. `.env` contains secrets.
- Rotate `LLM_WS_TOKEN`, LLM API keys, and Baileys auth if leaked.
- Media handler enforces size limits (`DOWNLOAD_TIMEOUT_MS`, validation in
  `mediaHandler.ts`) to prevent OOM from large WhatsApp media.
- Activation codes gate access when `REQUIRE_ACTIVATION=true`.
- Permission system controls tool availability (delete, mute, kick).
- Sub-agent communication uses a shared filesystem contract or base64 inlining
  (never passes secrets to the sub-agent).
