# WazzapAgents

[![Node 18+](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![Python 3.10+](https://img.shields.io/badge/python-%3E%3D3.10-blue)](https://python.org/)
[![License](https://img.shields.io/badge/license-ISC-lightgrey)](./package.json)

A WhatsApp AI agent: it links a WhatsApp account, listens to your chats, and
replies with an LLM — plus group moderation, stickers, quizzes, and slash
commands. It runs as **two processes** you start together:

- a **Node.js gateway** (Baileys) that talks to WhatsApp, and
- a **Python bridge** that runs the LLM pipeline.

> 🚀 **Want to deploy on a Pterodactyl panel instead of running locally?**
> See **[pterodactyl/README.md](./pterodactyl/README.md)** for the full guide
> (including pairing without a QR code and running on a fixed node-only image).

> For architecture, concepts, and developer docs, see
> [AGENTS.md](./AGENTS.md); the wire protocol lives in [CONTRACT.md](./CONTRACT.md).

---

## Prerequisites

- **Node.js 18+** (tested up to Node 25)
- **Python 3.10+**
- **pnpm 9+** — `npm i -g pnpm` or `corepack enable pnpm`
- **ffmpeg** on your `PATH` — only needed for the `/sticker` video → sticker
  feature; everything else works without it.
- An **OpenAI-compatible LLM API key** (OpenAI, OpenRouter, etc.)
- A phone with **WhatsApp** to link the bot to.

---

## Quick start

### 1. Install dependencies

```bash
pnpm install                      # Node gateway
pip install -r requirements.txt   # Python bridge (Python 3.10+)
```

### 2. Configure

Copy the minimal env template and fill in your keys:

```bash
cp .env.minimal.example .env
```

Then edit `.env`:

```dotenv
# Pair without a QR: the bot's WhatsApp number, digits only with country code.
# Leave empty to pair via QR instead.
WA_PAIRING_NUMBER=6281234567890

ASSISTANT_NAME=LLM                # bot display name
BOT_OWNER_JIDS=628123456789       # owner number(s), for owner-only commands

# LLM2 = the responder (required to actually reply).
LLM2_ENDPOINT=                    # empty = OpenAI default; or e.g. OpenRouter
LLM2_MODEL=gpt-4o
LLM2_API_KEY=sk-...

# Control panel network and login.
CONTROL_PANEL_HOST=127.0.0.1
CONTROL_PANEL_PORT=8080
CONTROL_PANEL_TOKEN=choose-a-private-token
```

That's the minimal set. `.env.minimal.example` documents the optional **LLM1**
router (a cheap model that gates replies in groups to save cost), and
[`.env.example`](./.env.example) is the full reference for every setting.

### 3. Run the bot

Start the **gateway first**, then the **bridge** (two terminals, or two
background processes):

```bash
# terminal 1 — Node gateway (WhatsApp side)
pnpm dev

# terminal 2 — Python bridge (LLM side)
PYTHONPATH=python python -m bridge.main
```

### 4. Link your WhatsApp

- **Pairing code (no QR):** with `WA_PAIRING_NUMBER` set, the gateway prints an
  8-character code in terminal 1:
  ```
  ================ WhatsApp Pairing Code ================
    Number : 6281234567890
    Code   : ABCD-EFGH
  ======================================================
  ```
  On the bot's phone: **WhatsApp → Linked Devices → Link a Device → Link with
  phone number**, then enter the code.
  If WhatsApp rejects or closes the attempt, the gateway deliberately does not
  retry automatically. Restart to make one fresh attempt; repeated rapid
  attempts can trigger a temporary WhatsApp pairing restriction. The default
  in-process cooldown is 15 minutes (`WA_PAIRING_RETRY_COOLDOWN_MS=900000`).
- **QR code:** leave `WA_PAIRING_NUMBER` empty and scan the QR printed in
  terminal 1 instead.

Once linked you'll see `WhatsApp socket connected`. Message the bot (or add it
to a group) and it replies. The WhatsApp session is saved under `./data/auth`,
so you only link once.

### Control panel

The Node gateway also serves a multi-tenant control panel at
`http://127.0.0.1:8080` by default. Enter `CONTROL_PANEL_TOKEN` on its login
screen. The API stays locked only when the token is empty; any non-empty token
is accepted.

From the panel you can:

- inspect Node, Python bridge, WhatsApp, queue, and per-tenant state;
- generate a native WhatsApp pairing code directly (leave
  `WA_PAIRING_NUMBER` empty if you want pairing to be panel-driven);
- reconnect or explicitly disconnect a WhatsApp session;
- edit chat/default settings, prompts, memories, models, activation codes,
  tenant-wide bot config, and sticker catalogs;
- use locally persisted chat/group names for scopes without a live metadata
  sweep;
- edit the shared `.env` through focused System sections with secret values
  masked and restart-only fields marked;
- inspect durable sub-agent completion callbacks under **System → Sub-agent
  outbox**, retry terminal/pending deliveries, or discard only the callback
  envelope while retaining the sub-agent result and output files until normal
  idle cleanup;
- check the installed/upstream application and compatibility versions, then
  safely fast-forward update or restart both supervised services; and
- review the persistent control-panel audit trail.

The terminal renders only the first QR emitted by each unregistered socket, so
long-running logs are not flooded by Baileys' ~20-second QR refresh. Request a
fresh native code from the panel or explicitly reconnect the account when the
first QR expires.

While an account is unpaired or reconnecting, the bridge remains connected to
Node but parks cold sub-agent recovery, scheduled tasks, and direct-invoke
delivery. They resume only after WhatsApp reports `open`; pre-pair actions are
rejected before execution and remain safe to retry after pairing.

Sub-agent completion ownership transfers as soon as the bridge has durably
stored the result. A file larger than the bridge's 200 MiB staging limit is
reported as an explicit skipped output instead of keeping the entire callback
in an infinite retry loop. The text report and any other valid outputs remain
deliverable after pairing.

`package.json` carries an application `version` and a separate
`compatibilityVersion`. The latter must be incremented when an update may need
manual environment, dependency, database, or deployment changes. The panel
blocks silent cross-compatibility updates and presents an explicit warning.

The server binds loopback by default. Set `CONTROL_PANEL_HOST=0.0.0.0` to keep
localhost access and also listen on Tailscale/LAN, then open
`http://<tailscale-ip>:8080` from the other device. Set it to the server's exact
Tailscale IP to restrict the listener to that interface. Host and port can also
be changed from **System → Control panel network**; use **System → Runtime &
updates → Restart services** after
saving. When reachable from another device, keep the token private and use
Tailscale ACLs, a firewall, or an HTTPS reverse proxy. Pairing and session-reset
endpoints must never be exposed without access control.

---

## Using the bot

- **Direct messages** always get a reply.
- **Groups** respond based on the chat's mode (configure via `/setting`) and
  triggers (`/trigger`) — e.g. when mentioned, replied to, or by name.
- **Slash commands** (type `/help` in a chat to list them) cover settings,
  moderation, stickers, broadcasts, and more.

Owner-only commands (like `/broadcast`) require your number to be in
`BOT_OWNER_JIDS`.

---

## Useful commands

```bash
pnpm dev          # run the gateway (alias of pnpm start)
pnpm typecheck    # TypeScript type-check (must be 0 errors)
pnpm test         # Node tests
PYTHONPATH=python python -m pytest python/tests -q   # Python tests
```

---

## Multiple accounts (optional)

Open **Accounts → Add account** in the control panel, enter a tenant name/ID and
the WhatsApp phone number, then enter the generated pairing code in WhatsApp.
The account becomes live without restarting Node or the Python bridge.

The panel stores its catalog in the git-ignored `accounts.json`. Each account is
fully isolated under `tenants/<id>/{auth,db,media,stickers}` and owns a stable
callback port slot. Removing an account stops its runtime but deliberately keeps
that tenant directory, so an accidental removal does not destroy auth or data.

Manual `FOLDER_PATHS` and `ACCOUNTS_JSON` configuration remains supported for
custom deployments; see [`.env.example`](./.env.example).

---

## Deploy on Pterodactyl

To run on a Pterodactyl panel — even a locked-down managed host that only offers
a fixed node-only image — follow **[pterodactyl/README.md](./pterodactyl/README.md)**.

---

## License

ISC — see [package.json](./package.json).
