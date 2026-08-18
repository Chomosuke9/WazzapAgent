# Deploying WazzapAgents on Pterodactyl

WazzapAgents can run as a single-account server on a Node-only Pterodactyl
image. The included bootstrap provisions portable Python and optional media
tools without root access, then runs the Node gateway and Python bridge
together.

> This deployment does not include WazzapSubAgents.

## Compatibility requirement

The project needs this startup command:

```bash
if [[ -d .git ]] && [[ "${AUTO_UPDATE:-0}" == "1" ]]; then git pull; fi; exec /usr/local/bin/node /home/container/pterodactyl/ptero-boot.mjs
```

The stock public **node.js generic** egg cannot express that command through
its normal user-editable variables:

- it exposes `MAIN_FILE`, not `CMD_RUN`;
- `MAIN_FILE` is limited to 16 characters; and
- `pterodactyl/ptero-boot.mjs` is longer than that limit.

Ask the panel administrator to override the egg/server startup command, or use
a custom egg that exposes a free-form run command. If the host only provides
the stock egg's editable variables, this deployment is not compatible as-is.

## Resources

- Image: `ghcr.io/ptero-eggs/yolks:nodejs_24`
- Memory: about 1 GB
- Disk: about 2–3 GB
- CPU: 1 core is normally enough

Node 24 is intentional. The pinned `better-sqlite3` version has a matching ABI
137 prebuild, so the server does not need a native compilation toolchain.

## Files

| File | Purpose |
|---|---|
| `ptero-boot.mjs` | Small Node entrypoint that hands off to Bash |
| `ptero-bootstrap.sh` | Provisions tools and dependencies, then starts both services |
| `../start.sh` | Supervises the Node gateway and Python bridge together |
| `../.env.minimal.example` | Small starter configuration |
| `../.env.example` | Complete configuration reference |

## Setup

### 1. Install the repository

The current public generic Node egg uses these Git variables:

| Variable | Value |
|---|---|
| `GIT_ADDRESS` | Repository clone URL |
| `BRANCH` | Deployment branch |
| `USERNAME` | Private repository username, if needed |
| `ACCESS_TOKEN` | Private repository token, if needed |
| `AUTO_UPDATE` | `1` to pull on restart |

Do not substitute `GIT_BRANCH`, `GIT_USERNAME`, or `GIT_ACCESS_TOKEN`; those
are not the public egg's variable names.

### 2. Apply the startup command

For the public egg, the panel administrator must replace its startup command
with:

```bash
if [[ -d .git ]] && [[ "${AUTO_UPDATE:-0}" == "1" ]]; then git pull; fi; exec /usr/local/bin/node /home/container/pterodactyl/ptero-boot.mjs
```

If a different custom egg exposes `CMD_RUN`, use this value instead:

```text
node pterodactyl/ptero-boot.mjs
```

### 3. Create `.env`

In the **Files** tab, copy `.env.minimal.example` to `.env` and set:

```dotenv
LLM2_API_KEY=your-api-key
BOT_OWNER_JIDS=6281234567890
CONTROL_PANEL_TOKEN=replace-with-a-long-random-value
WA_PAIRING_NUMBER=6281234567890
```

For an OpenAI-compatible provider other than OpenAI, also set:

```dotenv
LLM2_ENDPOINT=https://openrouter.ai/api/v1
LLM2_MODEL=openai/gpt-4.1
```

The `.env` file and runtime data are Git-ignored and survive application
updates.

### 4. Start and pair

Start the server. First boot downloads and caches Python, dependencies, and
optional tools, so it takes longer than later boots.

With `WA_PAIRING_NUMBER` set, enter the 8-character console code at
**WhatsApp → Linked Devices → Link a Device → Link with phone number**. Leave
the variable empty to pair using the console QR instead.

The account is ready after the console shows the Python bridge connected and
WhatsApp open. Authentication is kept under `data/auth`, so normal restarts do
not require pairing again.

## What the bootstrap does

On first boot, `ptero-bootstrap.sh`:

1. downloads standalone CPython into `/home/container/.python`;
2. installs `requirements.txt`, cached by its content hash;
3. downloads ffmpeg, yt-dlp, and qrencode on a best-effort basis;
4. installs Deno under `/home/container/.deno`;
5. installs Node dependencies and repairs the `better-sqlite3` prebuild when
   needed; and
6. runs `start.sh`, which keeps the gateway and bridge lifecycles tied.

All persistent files stay under `/home/container`.

## Control panel

The control panel defaults to `127.0.0.1:8080`. To expose it through
Pterodactyl, assign a separate allocation and set:

```dotenv
CONTROL_PANEL_HOST=0.0.0.0
CONTROL_PANEL_PORT=the-separate-allocation-port
```

Use a strong `CONTROL_PANEL_TOKEN`, HTTPS, and firewall or private-network
rules. Never reuse the internal WebSocket allocation.

## Updating

With `AUTO_UPDATE=1`, the public egg pulls on restart. The control panel also
supports compatibility-aware, fast-forward-only updates. Both paths preserve
`.env`, `data`, `.python`, and the cached optional tools.

## Re-pairing

To replace a logged-out or corrupted WhatsApp session:

1. stop the server;
2. delete only `data/auth`; and
3. start the server and pair again.

Do not delete the rest of `data`; it contains settings and chat databases.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Server starts `index.js` or `ts-node` | The required startup override was not applied; contact the panel administrator |
| `better-sqlite3` binding or ABI error | Confirm Node 24, remove only the stale `node_modules/better-sqlite3` directory, and restart |
| Bot connects but never replies | Confirm the Python bridge started and `LLM2_API_KEY` is set |
| No pairing code or QR | A linked account does not show a new code; otherwise check `WA_PAIRING_NUMBER` is digits-only |
| QR appears as raw text | qrencode provisioning failed; use `WA_PAIRING_NUMBER` for code pairing |
| Video sticker fails | ffmpeg is optional and may not have provisioned; other features still work |
| Python dependency install fails | Restart to retry a transient download; the success marker is written only after installation completes |
| `.env` change has no effect | Restart; network bindings and several runtime settings are read at startup |
