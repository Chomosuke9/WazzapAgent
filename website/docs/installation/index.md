---
sidebar_position: 1
description: Install WazzapAgents locally or on a Linux server.
---

# Installation

This guide installs one WhatsApp account on a local machine or Linux server.
After it works, you can add more accounts from the control panel without
repeating the installation.

:::tip Choose your deployment

- Continue below for a normal Linux, macOS, or Windows installation.
- Use the [Pterodactyl guide](/installation/pterodactyl) for a managed panel.

:::

## Requirements

| Software | Required | Notes |
|---|---:|---|
| Node.js 18 or newer | Yes | Node 24 is recommended for deployments |
| Python 3.10 or newer | Yes | Use a virtual environment when possible |
| pnpm 9 or newer | Yes | Enable with `corepack enable pnpm` |
| ffmpeg | No | Only needed for video stickers and some downloads |
| yt-dlp | No | Only needed by `/download` for supported websites |

You also need a WhatsApp account and an API key for an OpenAI-compatible LLM
provider.

## 1. Download the project

```bash
git clone https://github.com/Chomosuke9/WazzapAgent.git
cd WazzapAgent
```

## 2. Create the configuration

Copy the small starter configuration:

```bash
cp .env.minimal.example .env
```

On Windows PowerShell, use:

```powershell
Copy-Item .env.minimal.example .env
```

Open `.env` and fill in these values:

```dotenv
# Required for AI replies
LLM2_API_KEY=your-api-key

# Recommended: your number, digits only with country code
BOT_OWNER_JIDS=6281234567890

# Recommended: a long private control-panel password/token
CONTROL_PANEL_TOKEN=replace-with-a-long-random-value

# Optional: set this for pairing by code; leave empty for QR/panel pairing
WA_PAIRING_NUMBER=6281234567890
```

The built-in defaults use OpenAI's API and the `gpt-4.1` model. For OpenRouter
or another compatible provider, also set its base URL and model:

```dotenv
LLM2_ENDPOINT=https://openrouter.ai/api/v1
LLM2_MODEL=openai/gpt-4.1
```

The endpoint must be an OpenAI-compatible base URL. Both a base URL and a URL
ending in `/chat/completions` are accepted.

:::note

`.env.minimal.example` contains only the values most installations need. The
[full `.env.example`](https://github.com/Chomosuke9/WazzapAgent/blob/main/.env.example)
documents multi-account, networking, fallback-model, media, logging, and
Sub-Agent options.

:::

## 3. Install dependencies

Install the Node gateway:

```bash
pnpm install
```

Create a Python virtual environment and install the bridge:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

On Windows PowerShell:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

## 4. Start WazzapAgents

On Linux or macOS, the included supervisor starts both required processes:

```bash
bash start.sh
```

For development or Windows, start them separately.

Terminal 1 — Node gateway:

```bash
pnpm dev
```

Terminal 2 — Python bridge:

```bash
# Linux/macOS
PYTHONPATH=python python -m bridge.main
```

```powershell
# Windows PowerShell
$env:PYTHONPATH = "python"
python -m bridge.main
```

The Node gateway is the WebSocket server, so start it before the Python bridge.

## 5. Link WhatsApp

Choose one method:

1. **Pairing code:** set `WA_PAIRING_NUMBER`. Copy the 8-character code from
   the console into **WhatsApp → Linked Devices → Link a Device → Link with
   phone number**.
2. **QR code:** leave `WA_PAIRING_NUMBER` empty and scan the QR printed in the
   console.
3. **Control panel:** leave `WA_PAIRING_NUMBER` empty, open
   `http://127.0.0.1:8080`, sign in with `CONTROL_PANEL_TOKEN`, and request a
   pairing code from the account screen.

The session is saved under `data/auth`, so a restart does not require pairing
again.

## 6. Verify the installation

Before testing a message, confirm that the logs show all three states:

- the Node WebSocket server is listening;
- the Python bridge is connected; and
- WhatsApp reports `open` or `WhatsApp socket connected`.

Then send a direct message to the bot. With the minimal configuration, it can
reply immediately; adding a model through `/modelcfg` is optional. Use
`/modelcfg` only when you want a different default or a selectable model list.

Useful first checks:

```text
/info
/help
/setting
```

Owner-only commands require the sender to match `BOT_OWNER_JIDS`. A phone
number is normally enough because the gateway resolves its WhatsApp LID after
connecting. See [How to get a LID](/installation/how-to-get-lid) if you need to
troubleshoot owner detection.

## Control panel and more accounts

The control panel listens on `http://127.0.0.1:8080` by default. Its management
API stays locked until `CONTROL_PANEL_TOKEN` is set.

Use **Accounts → Add account** to create another isolated tenant. The panel
stores its managed catalog in the git-ignored `accounts.json`; each account has
its own `auth`, `db`, `media`, and `stickers` directories. Removing an account
stops its runtime but preserves its data directory.

:::warning

Loopback is the safe default. If you expose the panel to Tailscale, a LAN, or
the internet, use a strong token plus network access controls and HTTPS. Never
publish the internal WebSocket port without `LLM_WS_TOKEN`.

:::

## Optional features

- [Configure WazzapSubAgents](/installation/sub-agent) for document processing
  and code-execution tasks.
- Read the [Getting Started guide](/installation/getting-started) to add the bot
  to a group and choose a response mode.
- Use the [complete environment reference](https://github.com/Chomosuke9/WazzapAgent/blob/main/.env.example)
  for advanced deployments.
