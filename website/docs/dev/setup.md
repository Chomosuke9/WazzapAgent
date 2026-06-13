---
sidebar_position: 2
---

# Development Setup

Guide for setting up the WazzapAgents development environment.

## Prerequisites

| Software | Version | Notes |
|----------|---------|-------|
| Node.js | 18+ | Tested with Node 25 |
| pnpm | 9+ | `npm i -g pnpm` or `corepack enable pnpm` |
| Python | 3.10+ | For the bridge |
| SQLite | 3.x | Usually pre-installed on most OS |

## Installation

### 1. Clone Repository

```bash
git clone https://github.com/Chomosuke9/WazzapAgents.git
cd WazzapAgents
```

### 2. Setup Environment Variables

```bash
cp .env.example .env
```

Edit `.env` and fill in at minimum:

```bash
# Node.js gateway — WebSocket SERVER listen port (default 3000)
WS_LISTEN_PORT=3000
# Host the gateway binds to (default 127.0.0.1; use 0.0.0.0 for cross-host)
WS_BIND_HOST=127.0.0.1

# Python bridge — URL each WaSocket client dials (default ws://localhost:3000)
NODE_URL=ws://localhost:3000

# Optional — shared bearer token enforced by Node and sent by the Python client
LLM_WS_TOKEN=

# Optional — API keys for LLM providers
LLM1_API_KEY=sk-...
LLM2_API_KEY=sk-...
```

### 3. Install Dependencies — Node.js Gateway

```bash
pnpm install
```

### 4. Install Dependencies — Python Bridge

```bash
pip install -r requirements.txt
```

Or with a virtual environment (recommended):

```bash
python -m venv .venv
source .venv/bin/activate  # Linux/macOS
pip install -r requirements.txt
```

## Running

Start the Node.js gateway **first** — it is the WebSocket server that the Python bridge clients dial.

**Terminal 1 — Node.js Gateway (WS server):**
```bash
pnpm dev
```

**Terminal 2 — Python Bridge (WS client):**
```bash
python -m python.bridge.main
```

On first run, the gateway will display a QR code in the terminal. Scan it with WhatsApp to pair.

## Environment Variables

### Gateway (Node.js)

| Variable | Default | Description |
|----------|---------|-------------|
| `WS_LISTEN_PORT` | `3000` | WS server listen port (Node is the server) |
| `WS_BIND_HOST` | `127.0.0.1` | Host the WS server binds to (`0.0.0.0` for cross-host) |
| `INSTANCE_ID` | `default` | Gateway instance identifier |
| `LLM_WS_TOKEN` | *(empty)* | Bearer token for WS authentication |
| `DATA_DIR` | `./data` | Runtime data directory |
| `MEDIA_DIR` | `./data/media` | Media storage directory |
| `LOG_LEVEL` | `info` | Log level (debug, info, warn, error) |
| `WS_RECONNECT_MS` | `5000` | WS reconnect interval in ms |
| `GROUP_METADATA_TIMEOUT_MS` | `8000` | Group metadata fetch timeout |
| `DOWNLOAD_TIMEOUT_MS` | `60000` | Media download timeout |
| `SEND_TIMEOUT_MS` | `60000` | Message send timeout |
| `UPSERT_CONCURRENCY` | `2` | Message processing concurrency |
| `BOT_OWNER_JIDS` | *(empty)* | Owner JIDs, comma-separated |

### Bridge (Python)

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_URL` | `ws://localhost:3000` | URL each WaSocket client dials |
| `HISTORY_LIMIT` | `20` | History messages per chat |
| `INCOMING_DEBOUNCE_SECONDS` | `5` | Debounce window for batching |
| `INCOMING_BURST_MAX_SECONDS` | `20` | Maximum burst window duration |
| `HISTORY_LIMIT` | `20` | History messages per chat |
| `INCOMING_DEBOUNCE_SECONDS` | `5` | Debounce window for batching |
| `INCOMING_BURST_MAX_SECONDS` | `20` | Maximum burst window duration |
| `ASSISTANT_NAME` | `LLM` | Bot display name in context |
| `CONTEXT_TIME_UTC_OFFSET_HOURS` | *(auto)* | UTC offset for timestamps |

### LLM1 (Gating)

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM1_ENDPOINT` | *(OpenAI default)* | LLM1 API endpoint |
| `LLM1_MODEL` | `openai/gpt-oss-20b` | Model for gating |
| `LLM1_API_KEY` | *(empty)* | LLM1 API key |
| `LLM1_TEMPERATURE` | `0` | LLM1 temperature |
| `LLM1_TIMEOUT` | `8` | Timeout in seconds |
| `LLM1_HISTORY_LIMIT` | `20` | History limit for LLM1 context |
| `LLM1_MESSAGE_MAX_CHARS` | `500` | Max chars per message for LLM1 |
| `LLM1_ENABLE_MEDIA_INPUT` | `0` | Enable multimodal LLM1 input |
| `LLM1_FALLBACK_ENDPOINT` | *(reuse LLM1)* | Fallback endpoint |
| `LLM1_FALLBACK_MODEL` | *(empty)* | Fallback model |

### LLM2 (Responder)

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM2_ENDPOINT` | *(OpenAI default)* | LLM2 API endpoint |
| `LLM2_MODEL` | `gpt-5.3` | Model for responder |
| `LLM2_API_KEY` | *(empty)* | LLM2 API key |
| `LLM2_TEMPERATURE` | `0.5` | LLM2 temperature |
| `LLM2_TIMEOUT` | `20` | Timeout in seconds |
| `LLM2_RETRY_MAX` | `0` | Max retries on timeout |
| `LLM2_RETRY_BACKOFF_SECONDS` | `0.8` | Backoff between retries |
| `LLM2_ENABLE_MEDIA_INPUT` | `1` | Enable multimodal LLM2 input |
| `LLM2_FALLBACK_ENDPOINT` | *(reuse LLM2)* | Fallback endpoint |
| `LLM2_FALLBACK_MODEL` | *(empty)* | Fallback model |

### Bridge Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `BRIDGE_LOG_LEVEL` | `info` | Bridge log level |
| `BRIDGE_LOG_PROMPT_FULL` | `0` | Log full LLM2 prompt |
| `BRIDGE_LOG_EXTRAS_LIMIT` | `4000` | Extras character limit in logs |
| `BRIDGE_LOG_CHAT_LABEL_WIDTH` | `24` | Chat label width in logs |
| `BRIDGE_SLOW_BATCH_LOG_MS` | `2000` | Slow batch log threshold |

## Running Tests

```bash
# All Python tests
python -m pytest python/tests/

# Specific test
python -m unittest python/tests/test_llm_context_serialization.py
```

:::info
No Node.js test framework is configured yet. If adding tests for the gateway, use **vitest**.
:::

## Building Documentation

```bash
cd website
npm ci
npm run build    # Production build
npm start        # Local dev server
```

## Directory Structure

```
WazzapAgents/
├── src/                        # Node.js Gateway (WS SERVER, TypeScript)
│   ├── index.ts                # Composition root: config, WS server, per-tenant accounts
│   ├── config.ts               # Configuration (all process.env reads)
│   ├── logger.ts               # Logging
│   ├── mediaHandler.ts         # Media download & validation
│   ├── server/                 # WebSocket server
│   │   ├── wsServer.ts         # WS server: accept clients on WS_LISTEN_PORT
│   │   └── accountRegistry.ts  # Bind each client to its folder_path account
│   ├── account/                # Per-tenant aggregate (one AccountEntry per folder_path)
│   │   ├── baileysFactory.ts   # Create/resume Baileys socket; owns Database + repos
│   │   ├── accountContext.ts   # Per-account caches / sendQueue / forwarder
│   │   ├── actionDispatcher.ts # Dispatch Python→Node actions
│   │   └── eventForwarder.ts   # Forward Node→Python events
│   ├── db/                     # Per-tenant SQLite
│   │   ├── Database.ts         # Owns one tenant's connections
│   │   ├── schema/             # Table creation + migrations
│   │   └── repositories/       # Domain repositories
│   ├── protocol/               # Wire types
│   │   ├── types.ts            # Frames, WaStatus, payloads
│   │   └── ports.ts            # Interfaces (WaSocketLike, AccountForwarder)
│   └── wa/                     # WhatsApp modules
│       ├── domain/             # caches, identifiers, participants, groupContext, messageParser
│       ├── connection.ts       # Socket lifecycle
│       ├── inbound.ts          # Incoming → payload
│       ├── outbound.ts         # Send messages/media
│       ├── actions.ts          # React & delete
│       ├── moderation.ts       # Kick members
│       ├── presence.ts         # Mark read & typing
│       ├── runCommand.ts       # run_command handler
│       ├── sendQueue.ts        # Per-JID send queue
│       ├── events.ts           # Synthetic events
│       ├── utils.ts            # Concurrency helpers
│       ├── commands/           # CommandRegistry + CommandContext
│       ├── command/            # Per-command handlers
│       └── interactive/        # NativeFlow messages
├── python/
│   ├── wasocket/                # make_wa_socket SDK (WS CLIENT)
│   │   ├── socket.py           # WaSocket class + factory
│   │   ├── transport.py        # WSClientTransport: dial NODE_URL, reconnect
│   │   ├── protocol.py         # Frame dataclasses
│   │   └── events.py           # WhatsAppMessage model
│   ├── bridge/                  # Python LLM Bridge
│   │   ├── main.py             # Boot: load accounts, one AgentSession per account
│   │   ├── accounts.py         # Multi-account config loader
│   │   ├── config.py           # Configuration
│   │   ├── session.py          # AgentSession composition root
│   │   ├── history.py          # History management
│   │   ├── stickers.py         # Sticker catalog
│   │   ├── dashboard.py        # Stats buffer + flush
│   │   ├── log.py              # Logging
│   │   ├── agent/              # Injectable per-account collaborators
│   │   ├── db/                 # Per-tenant repositories
│   │   ├── media/              # Media + sticker resolution
│   │   ├── llm/                # LLM pipeline (llm1, llm2, schemas, prompt, …)
│   │   ├── messaging/          # Message pipeline (processing, filtering, actions, gateway, …)
│   │   ├── tools/             # PIL sticker creation
│   │   └── subagent/          # Sub-agent integration
│   └── systemprompt.txt        # LLM2 system prompt template
├── docs/llm-architecture/       # Architecture docs
├── website/                     # Docusaurus docs (Indonesian + English)
├── data/                        # Default tenant folder (auto-created, git-ignored)
│   ├── auth/                    # WhatsApp session
│   ├── media/                   # Media files
│   ├── stickers/                # Sticker catalog
│   └── db/                      # Per-tenant SQLite DBs
│       ├── settings.db          # Chat settings & model configs
│       ├── stats.db             # Dashboard statistics
│       ├── moderation.db        # Mute state
│       ├── subagent.db          # Sub-agent state
│       └── stickers.db          # Sticker catalog DB
├── .env.example            # Env template
├── package.json            # Node.js deps
└── requirements.txt        # Python deps
```
