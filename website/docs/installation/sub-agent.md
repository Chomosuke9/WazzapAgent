---
sidebar_position: 3
description: Connect the optional WazzapSubAgents executor service.
---

# Sub-Agent Setup

WazzapSubAgents is optional. Install it only when the bot needs to process
documents, run code in an isolated sidecar, or return generated files. Normal
chat, commands, moderation, stickers, and quizzes do not require it.

## 1. Run WazzapSubAgents

```bash
git clone https://github.com/Chomosuke9/WazzapSubAgents.git
cd WazzapSubAgents
cp .env.example .env
```

Set the required model and API credentials described by that project's
`.env.example`, then start its Docker Compose stack:

```bash
docker compose up -d
```

The default services listen on:

- API: `http://localhost:5000`
- executor sidecar: `http://localhost:5001`

## 2. Create two different shared secrets

The integration has two authenticated directions. Generate two long random
values and do not reuse them:

- `SUBAGENT_API_TOKEN` authenticates WazzapAgents requests to WazzapSubAgents.
- `SUBAGENT_WEBHOOK_TOKEN` authenticates callbacks to WazzapAgents.

Configure each value identically in both projects. Do not paste real secrets
into chat messages or commit them to Git.

## 3. Configure WazzapAgents

When WazzapSubAgents runs in Docker and WazzapAgents runs on the host, add this
to the WazzapAgents `.env`:

```dotenv
SUBAGENT_URL=http://localhost:5000
SUBAGENT_API_TOKEN=replace-with-first-long-random-value
SUBAGENT_WEBHOOK_URL=http://host.docker.internal:8081/subagent/callback
SUBAGENT_WEBHOOK_TOKEN=replace-with-second-long-random-value
```

The Docker callback URL makes the bridge listen beyond loopback, so startup
fails closed unless `SUBAGENT_WEBHOOK_TOKEN` is set.

For a fully native, same-host deployment, use:

```dotenv
SUBAGENT_WEBHOOK_URL=http://localhost:8081/subagent/callback
```

For multiple WazzapAgents accounts, preserve each stable account slot in the
callback URL:

```dotenv
SUBAGENT_WEBHOOK_URL=http://host.docker.internal:{port}/subagent/callback
```

The default base port is `8081`; each account uses `base + slot`.

## 4. File transfer

Small inputs can be sent inline. Larger files use authenticated resumable
uploads, so a shared filesystem is not required for cross-host deployments.

For a same-host Docker setup, both projects can also mount the same host
directory as `/storage`. In WazzapSubAgents:

```dotenv
SUBAGENT_STORAGE_DIR=/storage
WORKDIR_BASE=/storage/subagent_work
```

For a native WazzapAgents installation, leave
`SUBAGENT_INPUT_STAGING_DIR` unset. It defaults to `data/subagent_in`.

## 5. Enable and test it

Restart WazzapAgents after changing restart-bound webhook settings. Then, as
the bot owner, enable the feature in the target chat:

```text
/subagent on
```

Ask for a task that needs tooling, such as processing an attached document.
The expected flow is:

1. WazzapAgents accepts and submits the task.
2. WazzapSubAgents reports progress through the callback.
3. WazzapAgents sends the final report and valid output files to WhatsApp.

Use `/subagent off` to disable it for the chat.

:::warning

The executor runs generated code. Keep it isolated, protect both credentials,
and enable it only for chats you trust.

:::
