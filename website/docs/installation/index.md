---
sidebar_position: 1
---

# Installation Guide

This guide walks you through installing and running WazzapAgents on a server or local machine.

## Prerequisites

| Software | Version | Notes |
|----------|---------|-------|
| Node.js | 20+ | Required by the Docusaurus website; the gateway also runs on Node 18+ |
| pnpm | 9+ | `npm i -g pnpm` or `corepack enable pnpm` |
| Python | 3.10+ | For the Python bridge |
| SQLite | 3.x | Usually already installed by the OS |

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/Chomosuke9/WazzapAgents.git && cd WazzapAgents
```

![Clone Repository](/img/2026-05-05-143910_hyprcap.png)

Check that the repository was cloned:

![Check Repository](/img/check_repo.png)

If it worked, you will see the project files:

![Check Repository Success](/img/check_success.png)

### 2. Set Up Environment Variables

```bash
cp .env.example .env
```

Then edit the file with a text editor, for example:

```bash
nano .env
```

![Nano .env](/img/nano_env.png)

Fill in at least:

```bash
# The Node gateway is the WebSocket SERVER. Port it listens on:
WS_LISTEN_PORT=3000

# URL the Python bridge (client) dials to reach the gateway.
# Must match WS_LISTEN_PORT above.
NODE_URL=ws://localhost:3000

# Optional — bearer token for WS authentication (enforced by Node, sent by the Python client)
LLM_WS_TOKEN=
# Optional — WS server bind host (default 127.0.0.1; set 0.0.0.0 for cross-host)
WS_BIND_HOST=127.0.0.1

# Assistant display name and aliases
ASSISTANT_NAME=LLM

# OpenAI-compatible model endpoint and API key
LLM2_ENDPOINT=
LLM2_API_KEY=
```

Then add your owner JID or LID:

```bash
# Examples: 628123456789@s.whatsapp.net, 193058310034@lid
BOT_OWNER_JIDS=
```

:::note
Each owner can use either a phone JID or an LID. If the phone JID does not work, use `/info` to get the LID.

[See the full LID guide here](/installation/how-to-get-lid).
:::

### 3. Install Dependencies

**Node.js gateway:**

```bash
pnpm install
```

**Python bridge:**

```bash
pip install -r requirements.txt
```

Or with a virtual environment (recommended):

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 4. Run WazzapAgents

Two components must run at the same time. The Node gateway is the WebSocket **server**, so start the **gateway first**, then the Python bridge (the client) that dials into it.

:::tip
Use a terminal multiplexer such as Tmux, Zellij, or Byobu so each service can keep running in the background.
:::

**Terminal 1 — Node.js gateway (WS server):**

```bash
pnpm dev
```

**Terminal 2 — Python bridge (WS client):**

```bash
PYTHONPATH=python python -m bridge.main
```

On first run, the gateway prints a QR code in the terminal. Scan it with WhatsApp to pair the account.

### 5. Add a Model

Add at least one AI model before using the bot. Without a model, the bot cannot do much.

Steps:

1. Make sure your number is registered as an owner. If not, [configure it first](/installation/how-to-get-lid).
2. Send `/modelcfg add` to the bot with this format:

![model add](/img/slash_model_add.jpg)

```txt
/modelcfg add <model id>|<model name>|<model description>|<vision support>
```

:::warning
1. Use `|` as the separator.
2. `<model id>` must be accurate; the bot does not automatically fix it.
3. `<vision support>` must be correct. If the model does not support vision, do not set it to `true`, or the bot may stop responding.
:::

### Verify the Model

Send `/setting` to open this menu:

![slash setting](/img/slash_setting.jpg)

Tap `Change model`. If the previous step was correct, you should see:

![slash setting model](/img/gpt_model.jpg)

## Sub-Agent

**Sub-Agent** is a separate containerised executor service that runs autonomous agents inside an isolated Docker sandbox. It receives instructions from WazzapAgents, executes tools (bash, Python, JavaScript) inside a sandboxed sidecar, and returns results and output files back to WhatsApp via webhooks.

Unlike the main bot which only replies to chats, Sub-Agent can process heavy tasks that require real code execution.

### When to Enable It

Use Sub-Agent when you want the assistant to handle tasks such as:

- Reading and processing uploaded files (PDF, DOCX, XLSX, PPTX, and more)
- Extracting tables or summaries from documents
- Running small scripts (bash, Python, JavaScript) in an isolated sandbox
- Creating output files (reports, images, documents) and sending them back to WhatsApp

Keep it disabled if you only need normal chat replies or moderation.

:::info
Sub-Agent **cannot** access the internet directly. It can only process files and run code inside its own sandbox.
:::

### Architecture Overview

Sub-Agent runs as a separate service ([WazzapSubAgents](https://github.com/Chomosuke9/WazzapSubAgents)) consisting of two containers:

1. **executor-service** (Flask, port 5000) — receives requests from WazzapAgents, runs the agent loop (LLM ReAct), and sends callback webhooks.
2. **executor-executor** (sidecar, port 5001) — executes bash/Python/JavaScript code produced by the agent inside a sandbox.

WazzapAgents sends tasks to `/execute`, Sub-Agent processes them asynchronously, then sends results back via webhook to WazzapAgents. If there is a queue, users are notified of their queue position.

### 1. Run WazzapSubAgents

Clone and configure the Sub-Agent service:

```bash
git clone https://github.com/Chomosuke9/WazzapSubAgents.git && cd WazzapSubAgents
cp .env.example .env
```

Edit `.env` and set at least:

```bash
LLM_API_KEY=<your API key>
AGENT_MODEL_LOW=<model for the sub-agent>
```

:::note
`AGENT_MODEL` (without `_LOW`) is still supported for backward compatibility and will be used as `AGENT_MODEL_LOW` if `AGENT_MODEL_LOW` is not set.
:::

Optionally, configure a higher-quality model for complex tasks:

```bash
AGENT_MODEL_HIGH=<more powerful model for complex tasks>
# If unset, falls back to AGENT_MODEL_LOW
AGENT_TEMPERATURE_LOW=0.7
AGENT_TEMPERATURE_HIGH=0.3
```

Run with Docker Compose (recommended):

```bash
docker-compose up -d
```

Or run natively (without Docker for the main service, only the sidecar uses Docker):

```bash
pip install -r requirements.txt
python main.py
```

The service exposes:

- Main API: `http://localhost:5000`
- Executor sidecar: `http://localhost:5001`

### 2. Connect WazzapAgents to the Sub-Agent

In the WazzapAgents `.env`, configure:

```bash
SUBAGENT_URL=http://localhost:5000
SUBAGENT_API_TOKEN=<the-same-main-api-token-in-both-services>
SUBAGENT_WEBHOOK_PORT=8081
SUBAGENT_WEBHOOK_URL=http://localhost:8081/subagent/callback
```

If WazzapSubAgents runs in Docker and needs to call back into WazzapAgents on the host, use:

```bash
SUBAGENT_WEBHOOK_URL=http://host.docker.internal:8081/subagent/callback
SUBAGENT_WEBHOOK_TOKEN=<the-same-long-random-secret-in-both-services>
```

This non-loopback callback URL makes the bridge bind `0.0.0.0` automatically.
Startup fails closed if the token is missing. For multiple accounts, use
`http://host.docker.internal:{port}/subagent/callback` so each account remains
routable. Explicit public or reverse-proxy ports are otherwise preserved.
`SUBAGENT_API_TOKEN` authenticates the opposite direction (main API calls and
large-output downloads), so use a different random value from
`SUBAGENT_WEBHOOK_TOKEN`.

:::tip
The Docker Compose file in WazzapSubAgents already maps `host.docker.internal` on Linux with `host-gateway`.
:::

### 3. Share Files Between Services

For file tasks, both services must read and write the same host directory. When using Docker Compose, use `/storage` as the shared directory:

```bash
# In WazzapSubAgents .env:
SUBAGENT_STORAGE_DIR=/storage
WORKDIR_BASE=/storage/subagent_work
```

When running natively (without Docker Compose), leave `SUBAGENT_INPUT_STAGING_DIR` unset and WazzapAgents will use `<project_root>/data/subagent_in` automatically.

Same-host deployments can use the shared directory directly. Cross-host
deployments stream non-inlined output files through the authenticated Sub-Agent
API; WazzapAgents verifies the advertised byte count and SHA-256 before sending
an attachment to WhatsApp.

### 4. Enable Sub-Agent in WhatsApp

Only the bot owner can toggle Sub-Agent:

```txt
/subagent on
/subagent off
/subagent global on
/subagent global off
```

Check the current chat setting:

```txt
/subagent
```

### 5. Test the Flow

After both services are running:

1. Send `/subagent on` in a chat.
2. Ask for a task that needs tooling, for example: "Read this document and extract the tables."
3. The main agent should acknowledge the task.
4. Sub-Agent processes the task asynchronously. If there is a queue, you will be notified of your position.
5. Sub-Agent sends progress callbacks via the webhook.
6. When done, WazzapAgents summarizes the report and sends any output files.

:::warning
Sub-Agent runs code inside a Docker sandbox. Although isolated, only run it on a server you control, keep API keys private, and only enable it for trusted chats.
:::

## Environment Variables

### Gateway (Node.js)

| Variable | Default | Description |
|----------|---------|-------------|
| `WS_LISTEN_PORT` | `3000` | Port the WS server (Node gateway) listens on |
| `NODE_URL` | `ws://localhost:3000` | URL the Python bridge dials to reach the gateway |
| `WS_BIND_HOST` | `127.0.0.1` | WS server bind host (set `0.0.0.0` for cross-host) |
| `LLM_WS_TOKEN` | *(empty)* | Bearer token for WS authentication |
| `INSTANCE_ID` | `default` | Gateway instance identifier |
| `DATA_DIR` | `./data` | Runtime data directory |
| `MEDIA_DIR` | `./data/media` | Media storage directory |
| `LOG_LEVEL` | `info` | Log level (debug, info, warn, error) |
| `WS_RECONNECT_MS` | `5000` | WS reconnect interval in ms |
| `GROUP_METADATA_TIMEOUT_MS` | `8000` | Group metadata fetch timeout |
| `DOWNLOAD_TIMEOUT_MS` | `60000` | Media download timeout |
| `SEND_TIMEOUT_MS` | `60000` | Send message timeout |
| `UPSERT_CONCURRENCY` | `2` | Message processing concurrency |
| `BOT_OWNER_JIDS` | *(empty)* | Owner JIDs/LIDs, comma-separated |

### Bridge (Python)

| Variable | Default | Description |
|----------|---------|-------------|
| `HISTORY_LIMIT` | `20` | History messages per chat |
| `INCOMING_DEBOUNCE_SECONDS` | `5` | Debounce window for batching |
| `INCOMING_BURST_MAX_SECONDS` | `20` | Maximum burst window duration |
| `ASSISTANT_NAME` | `LLM` | Bot display name in context |
| `CONTEXT_TIME_UTC_OFFSET_HOURS` | *(auto)* | UTC offset for timestamps |

### Sub-Agent (Bridge to WazzapSubAgents)

| Variable | Default | Description |
|----------|---------|-------------|
| `SUBAGENT_URL` | `http://localhost:5000` | WazzapSubAgents API URL |
| `SUBAGENT_API_TOKEN` | *(none)* | Bearer token for main API calls and non-inlined output downloads |
| `SUBAGENT_WEBHOOK_PORT` | `8081` | Local callback webhook port |
| `SUBAGENT_WEBHOOK_URL` | `http://localhost:8081/subagent/callback` | Callback URL sent to WazzapSubAgents |
| `SUBAGENT_WEBHOOK_HOST` | *(automatic)* | Loopback for local URLs, `0.0.0.0` for remote/Docker URLs |
| `SUBAGENT_WEBHOOK_TOKEN` | *(none)* | Shared callback secret; required on non-loopback binds |
| `SUBAGENT_OUTPUT_DOWNLOAD_TIMEOUT_S` | `300` | Timeout for a streamed non-inlined output |
| `SUBAGENT_ENABLED_DEFAULT` | `false` | Enable Sub-Agent by default for new chats |
| `SUBAGENT_WAIT_TIMEOUT_S` | `300` | Maximum wait for Sub-Agent completion callback |

### LLM1 (Routing)

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM1_ENDPOINT` | *(OpenAI default)* | LLM1 API endpoint |
| `LLM1_MODEL` | `openai/gpt-oss-20b` | Model for routing |
| `LLM1_API_KEY` | *(empty)* | LLM1 API key |
| `LLM1_TEMPERATURE` | `0` | LLM1 temperature |
| `LLM1_TIMEOUT` | `8` | Timeout in seconds |
| `LLM1_HISTORY_LIMIT` | `20` | History limit for LLM1 context |
| `LLM1_MESSAGE_MAX_CHARS` | `500` | Max chars per message for LLM1 |
| `LLM1_ENABLE_MEDIA_INPUT` | `0` | Enable LLM1 multimodal input |
| `LLM1_FALLBACK_ENDPOINT` | *(reuse LLM1)* | Fallback endpoint |
| `LLM1_FALLBACK_MODEL` | *(empty)* | Fallback model |
| `LLM1_FALLBACK_API_KEY` | *(reuse LLM1)* | Fallback API key — set this if the fallback endpoint uses a different key |

### LLM2 (Response)

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM2_ENDPOINT` | *(OpenAI default)* | LLM2 API endpoint |
| `LLM2_MODEL` | `gpt-5.3` | Default model — overridden by the database if a model has been added via `/modelcfg add` |
| `LLM2_API_KEY` | *(empty)* | LLM2 API key |
| `LLM2_TEMPERATURE` | `0.5` | LLM2 temperature |
| `LLM2_TIMEOUT` | `20` | Timeout in seconds |
| `LLM2_RETRY_MAX` | `0` | Max retries on timeout |
| `LLM2_RETRY_BACKOFF_SECONDS` | `0.8` | Backoff between retries |
| `LLM2_ENABLE_MEDIA_INPUT` | `1` | Enable LLM2 multimodal input |
| `LLM2_FALLBACK_ENDPOINT` | *(reuse LLM2)* | Fallback endpoint — if the primary fails, requests are retried against this endpoint |
| `LLM2_FALLBACK_API_KEY` | *(reuse LLM2)* | Fallback API key — set this if the fallback endpoint uses a different key |
| `LLM2_FALLBACK_MODEL` | *(empty)* | Fallback model — **ignored** if a model exists in the database, because the model is always taken from the DB for all targets |

:::info
**How LLM2 fallback works:** At runtime, the model is always taken from the database (configured via `/modelcfg add` and `/modelcfg`). The `LLM2_MODEL` and `LLM2_FALLBACK_MODEL` env vars are only used as a fallback when the database has no models at all. The endpoint and API key (`LLM2_ENDPOINT`, `LLM2_API_KEY`, `LLM2_FALLBACK_ENDPOINT`, `LLM2_FALLBACK_API_KEY`) remain important because they determine **which provider** receives the request. So if the primary endpoint times out or errors, the system automatically retries against the fallback endpoint using the same model (from the database).
:::
