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
- **QR code:** leave `WA_PAIRING_NUMBER` empty and scan the QR printed in
  terminal 1 instead.

Once linked you'll see `WhatsApp socket connected`. Message the bot (or add it
to a group) and it replies. The WhatsApp session is saved under `./data/auth`,
so you only link once.

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

Run several WhatsApp accounts from one bridge process by pointing it at multiple
tenant folders (`FOLDER_PATHS` or `ACCOUNTS_JSON`); each tenant is fully
isolated under `<folder_path>/{auth,db,media,stickers}`. See
[`.env.example`](./.env.example) and [AGENTS.md](./AGENTS.md) for details.

---

## Deploy on Pterodactyl

To run on a Pterodactyl panel — even a locked-down managed host that only offers
a fixed node-only image — follow **[pterodactyl/README.md](./pterodactyl/README.md)**.

---

## License

ISC — see [package.json](./package.json).
