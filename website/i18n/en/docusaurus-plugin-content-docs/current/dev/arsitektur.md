---
sidebar_position: 1
---

# Architecture

> For full developer context, see [AGENTS.md](https://github.com/Chomosuke9/WazzapAgents/blob/main/AGENTS.md) and [docs/llm-architecture/](https://github.com/Chomosuke9/WazzapAgents/tree/main/docs/llm-architecture).

WazzapAgents consists of two runtime components that communicate over WebSocket:

```
WhatsApp <──Baileys──> Node.js Gateway <──WebSocket──> Python LLM Bridge <──HTTP──> LLM API
```

## Main Components

### 1. Node.js Gateway (`src/`)

The gateway is responsible for:

- **WhatsApp connection** — Uses Baileys v7 to connect to WhatsApp via multi-device protocol.
- **Message parsing** — Extracts text, media, mentions, quoted messages, locations, and vCards from raw Baileys messages.
- **Forwarding to bridge** — Sends `incoming_message` payloads to the Python bridge via WebSocket.
- **Action execution** — Receives commands from the bridge (send, react, delete, kick, mark read, typing) and executes them on WhatsApp.
- **Interactive messages** — Sends interactive messages (buttons, carousels, lists) via `relayMessage` + `additionalNodes`.
- **Caching** — Stores message cache, group metadata (60s TTL), participant names, and sender ref registry in memory.

### 2. Python LLM Bridge (`python/bridge/`)

The bridge is responsible for:

- **WebSocket server** — Receives messages from the gateway and sends commands back.
- **Message batching** — Groups incoming messages in burst windows with debounce logic.
- **Two-stage LLM pipeline:**
  - **LLM1 (Gating)** — Decides whether the bot should respond. Lightweight and fast.
  - **LLM2 (Responder)** — Generates complete responses with conversation context and system prompt.
- **Slash commands** — Handles `/prompt`, `/reset`, `/permission` directly.
- **Storage** — Three separate SQLite databases: `settings.db`, `stats.db`, `moderation.db`.
- **History management** — Stores conversation history per chat in memory with configurable limits.

## Data Flow

### Incoming Message (User → Bot)

```
1. User sends message on WhatsApp
2. Baileys receives `messages.upsert` event
3. Gateway parses message (messageParser.js)
4. Gateway assigns contextMsgId & senderRef (identifiers.js)
5. Gateway sends `incoming_message` to bridge via WebSocket
6. Bridge batches messages (5s debounce, 20s max burst)
7. Bridge runs LLM1 (gating decision)
8. If LLM1 decides to respond → run LLM2
9. LLM2 generates response + tool calls
10. Bridge parses actions from LLM2 tool calls
11. Bridge sends commands to gateway via WebSocket
12. Gateway executes actions on WhatsApp, sends ack/error back
```

### Context Messages (Bot → Bridge)

Messages sent by the bot itself are also forwarded to the bridge as `contextOnly: true` and `triggerLlm1: false`. This enriches conversation context without causing loops.

## Message Identification

### contextMsgId

A 6-digit per-chat counter (`000000`–`999999`, wraps after `999999`). Used to reference messages in conversations — for example when the bot needs to reply to a specific message or delete a message.

### senderRef

A short deterministic ID per sender per chat, generated from SHA-1 hash of `chatId|senderId`. Used in all LLM interactions — **never** exposes real JIDs to the LLM.

## Data Storage

| Data | Location | Type |
|------|----------|------|
| WhatsApp session | `data/auth/` | Files (Baileys auth state) |
| Downloaded media | `data/media/` | Files (images, videos, etc.) |
| Sticker catalog | `data/stickers/` | Files (WebP) |
| Chat settings & model configs | `data/settings.db` | SQLite (WAL mode) |
| Dashboard statistics | `data/stats.db` | SQLite (WAL mode) |
| Mute state | `data/moderation.db` | SQLite (WAL mode) |
| Conversation history | Memory (RAM) | In-memory deque |
| Message cache | Memory (RAM) | In-memory Map |
| Group metadata | Memory (RAM) | TTL cache (60 seconds) |

> **Note:** Databases are split into three separate SQLite files to avoid locking contention. Each uses WAL mode for concurrent reads.

## Module Diagram

### Node.js Gateway

```
src/
├── index.js              ← Bootstrap, routes WS commands to WhatsApp actions
├── wsClient.js           ← WebSocket client to bridge (auto-reconnect, reliable queue)
├── config.js             ← Environment variable loading
├── logger.js             ← Pino structured logging
├── messageParser.js      ← Baileys message parsing → structured payload
├── mediaHandler.js       ← Media download & validation
├── identifiers.js        ← contextMsgId counter, senderRef registry
├── participants.js       ← Participant role mapping, name cache
├── groupContext.js       ← Group metadata cache
├── caches.js             ← In-memory caches (message, metadata, names)
├── db.js                 ← SQLite via better-sqlite3 (settings, models, stats)
└── wa/
    ├── connection.js     ← WhatsApp socket lifecycle, button handler
    ├── inbound.js        ← Incoming messages → payload
    ├── outbound.js       ← Send text/media/mentions
    ├── actions.js        ← React & delete message wrappers
    ├── moderation.js     ← Kick members
    ├── presence.js       ← Mark read & typing indicator
    ├── commandHandler.js ← Slash command dispatcher
    ├── commands.js       ← Command alias normalization
    ├── events.js         ← Synthetic context events
    ├── utils.js          ← Concurrency helpers
    ├── command/          ← Per-command handler modules
    │   ├── help.js, prompt.js, reset.js, permission.js
    │   ├── mode.js, trigger.js, dashboard.js, model.js
    │   ├── broadcast.js, info.js, debug.js, join.js
    │   ├── sticker.js, modelcfg.js, setting.js
    │   └── groupStatus.js, catch.js
    └── interactive/      ← NativeFlow interactive messages
        ├── sendInteractive.js  ← viewOnce + relayMessage + additionalNodes
        ├── sendButtons.js      ← Quick reply, CTA URL, copy, call buttons
        └── sendCarousel.js     ← Swipeable carousel cards
```

### Python Bridge

```
python/bridge/
├── main.py              ← WebSocket handler, batching, pipeline orchestration
├── config.py           ← Environment variable parsing, config constants
├── db.py                ← SQLite storage with in-memory caches
├── history.py           ← WhatsAppMessage dataclass, history formatting
├── media.py             ← Visual attachment processing for multimodal
├── stickers.py          ← Sticker catalog scanning (data/stickers/)
├── commands.py           ← Legacy slash command handler (Python side)
├── dashboard.py          ← Stats buffer + periodic flush
├── log.py                ← Structured logging with contextvars
├── llm/
│   ├── llm1.py          ← LLM1 gating/decision (should respond / express-only)
│   ├── llm2.py          ← LLM2 response generation + tools
│   ├── schemas.py        ← Tool schemas (JSON Schema / OpenAI function calling)
│   ├── prompt.py          ← System prompt assembly, history, metadata injection
│   ├── client.py          ← LLM client factory, fallback targets
│   ├── metadata.py       ← Context metadata: bot mention, reply signals
│   └── tool_utils.py      ← Cross-provider tool-call extraction
├── messaging/
│   ├── processing.py    ← Burst building, payload normalization
│   ├── filtering.py     ← Trigger check, prefix/trigger mode
│   ├── actions.py        ← Parse action lines from LLM2 output
│   ├── gateway.py       ← Send actions over WS to Node
│   └── moderation.py     ← Permission checks, payload merge
└── tools/
    └── sticker.py        ← PIL-based sticker creation (text overlay, EXIF)
```