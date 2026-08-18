---
sidebar_position: 2
description: Deploy WazzapAgents with a Pterodactyl Node.js server.
---

# Pterodactyl

WazzapAgents can run without root access on a Node-only Pterodactyl server. Its
bootstrap downloads a portable Python runtime and optional media tools into the
persistent server volume, then supervises the Node gateway and Python bridge
together.

:::warning Check the egg before buying a server

This project needs a custom startup command. The current public **node.js
generic** egg exposes `MAIN_FILE`, but limits it to 16 characters; the required
path `pterodactyl/ptero-boot.mjs` does not fit. It does not provide `CMD_RUN`.

Your host must either let an administrator override the egg's startup command,
or provide a custom egg with a free-form run-command variable. Editable server
variables alone are not sufficient with the stock public egg.

:::

## Recommended resources

- Image: `ghcr.io/ptero-eggs/yolks:nodejs_24`
- Memory: about 1 GB
- Disk: about 2–3 GB
- CPU: 1 core is usually enough

Node 24 is required by the included bootstrap so `better-sqlite3` can use the
matching prebuilt binary.

## 1. Configure repository installation

For the public generic Node egg, use its actual variable names:

| Variable | Value |
|---|---|
| `GIT_ADDRESS` | `https://github.com/Chomosuke9/WazzapAgent` |
| `BRANCH` | `main` or your deployment branch |
| `USERNAME` | Only for a private repository |
| `ACCESS_TOKEN` | Only for a private repository |
| `AUTO_UPDATE` | `1` to pull on restart |

Do not use `GIT_BRANCH`, `GIT_USERNAME`, or `GIT_ACCESS_TOKEN`; those are not
the stock egg's variable names.

## 2. Set the startup command

Ask the panel administrator to set the egg/server startup command to:

```bash
if [[ -d .git ]] && [[ "${AUTO_UPDATE:-0}" == "1" ]]; then git pull; fi; exec /usr/local/bin/node /home/container/pterodactyl/ptero-boot.mjs
```

If your host uses a different custom egg that exposes `CMD_RUN`, set:

```text
node pterodactyl/ptero-boot.mjs
```

The command preserves the egg's optional update-on-restart behavior, then
starts `ptero-bootstrap.sh`, which provisions Python, installs both sets of
dependencies, and runs `start.sh`.

## 3. Create `.env`

In the panel's **Files** tab, copy `.env.minimal.example` to `.env` and fill in:

```dotenv
LLM2_API_KEY=your-api-key
BOT_OWNER_JIDS=6281234567890
CONTROL_PANEL_TOKEN=replace-with-a-long-random-value
WA_PAIRING_NUMBER=6281234567890
```

For a provider other than OpenAI, also add `LLM2_ENDPOINT` and `LLM2_MODEL`.
The project defaults its internal WebSocket connection to loopback, so the
primary server allocation does not need to be exposed for Node-to-Python
communication.

## 4. Start and pair

Start the server. The first boot downloads and caches the portable runtime and
dependencies, so it takes longer than later boots.

When `WA_PAIRING_NUMBER` is set, copy the 8-character code from the console to
**WhatsApp → Linked Devices → Link a Device → Link with phone number**. Leave
the value empty to use the QR flow.

Wait for the console to show that the Python bridge is connected and WhatsApp
is open. The linked session and databases remain in the persistent volume.

## Exposing the control panel

The panel binds to `127.0.0.1:8080` by default. To access it through a
Pterodactyl allocation:

1. assign a separate allocation;
2. set `CONTROL_PANEL_HOST=0.0.0.0`;
3. set `CONTROL_PANEL_PORT` to that allocation's port; and
4. protect it with a strong token, HTTPS, and firewall or private-network rules.

Do not reuse the internal WebSocket allocation for the control panel.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Server launches `index.js` or `ts-node` | The custom startup command was not applied; contact the panel administrator |
| `better-sqlite3` binding/ABI error | Confirm the image is Node 24, remove only the stale `node_modules/better-sqlite3` directory, and restart |
| Bot connects but never replies | Confirm the Python bridge started and `LLM2_API_KEY` is present |
| No pairing code | Confirm the account is not already linked and the phone number contains digits plus country code only |
| Video stickers fail | ffmpeg provisioning is best-effort; other features can continue without it |
| Environment changes do not apply | Restart the server; several network and runtime values are bound at startup |

For bootstrap implementation details, see the repository's
[Pterodactyl README](https://github.com/Chomosuke9/WazzapAgent/blob/main/pterodactyl/README.md).
