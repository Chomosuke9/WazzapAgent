# Deploying WazzapAgents on Pterodactyl

Run WazzapAgents as a single-account server on a [Pterodactyl](https://pterodactyl.io)
panel using a **fixed node-only image** (the yolks `nodejs_XX` images) and the
prebuilt **"NodeJS Generic"** egg — i.e. a typical locked-down managed host where
you can only pick an image from a dropdown and fill in variables. **No custom
image, no custom egg, no root required.**

A small bootstrap provisions a **portable Python** and a **static ffmpeg** into
the persistent volume on first boot, then runs the Node gateway and the Python
bridge together.

| File | Purpose |
|------|---------|
| `ptero-boot.mjs` | Entrypoint set as the run command (`CMD_RUN`). The egg runs it as `/usr/local/bin/node …`; it hands off to the bootstrap. |
| `ptero-bootstrap.sh` | Provisions Python + ffmpeg into the volume (cached), installs deps, then runs the gateway + bridge with tied lifecycles. |
| `../.env.minimal.example` | Minimal env template (LLM2 key/model, owner JID, pairing number). Copy to `.env`. Full reference: [`../.env.example`](../.env.example). |

> Scope: **single account**, sub-agent integration **not** included.

> **Recommended server limits:** ~**1 GB RAM** (Node + Python + LLM client) and
> ~**2–3 GB disk** (Node modules, the portable Python, ffmpeg, media). A swap
> allowance helps during the first dependency install. CPU: 1 core is enough.

---

## How it works

The generic Node egg's startup does `git pull` → `npm install` →
`/usr/local/bin/${CMD_RUN}`. We point `CMD_RUN` at `ptero-boot.mjs`, which on
first boot:

1. Downloads a relocatable standalone **CPython** into `/home/container/.python`.
2. `pip install`s the bridge's `requirements.txt` into it (cached by hash).
3. Downloads a **static ffmpeg** into `/home/container/.ffmpeg` (best-effort;
   only used by `/sticker` video).
4. Ensures Node deps are present (incl. `tsx`).
5. Runs the **Node gateway** (`node --import tsx src/index.ts`) and the
   **Python bridge** (`python -m bridge.main`) together, communicating over
   loopback (`ws://127.0.0.1:${SERVER_PORT}`). If either process exits, the
   other is stopped so Pterodactyl restarts the whole server.

Everything — Baileys auth, SQLite DBs, media, the portable Python and ffmpeg —
lives under the persistent `/home/container` volume, so **you pair once** and the
heavy provisioning is cached (it re-runs only when `requirements.txt` changes).

---

## Setup

1. **Docker Image:** pick **`nodejs_22`** (or `nodejs_20`). Avoid `nodejs_23`
   for now — `better-sqlite3` needs a prebuilt binary for your Node version, and
   23 is new enough that one may be missing (there are no build tools on a
   node-only image to compile it). `sharp` is N-API based and works on any.
2. **Git repo variables:** set `GIT_ADDRESS` to the WazzapAgents repo, plus
   `GIT_BRANCH` and (for a private repo) `GIT_USERNAME` / `GIT_ACCESS_TOKEN`,
   exactly like any generic-Node deploy.
3. **Run command** (`CMD_RUN` variable): set it to
   ```
   node pterodactyl/ptero-boot.mjs
   ```
   (`node` is the one interpreter guaranteed to be in `/usr/local/bin`; the
   launcher then hands off to the bootstrap via `/bin/bash`.)
4. **App config — create a `.env` file.** In the panel's **Files** tab, copy
   `.env.minimal.example` to `.env` and fill in the values. Both the gateway and
   the bridge load `/home/container/.env` automatically, and `git pull` won't
   touch it (it's git-ignored), so it survives updates. The minimal set is:
   ```dotenv
   WA_PAIRING_NUMBER=6281234567890
   ASSISTANT_NAME=LLM
   BOT_OWNER_JIDS=628123456789
   LLM2_ENDPOINT=
   LLM2_MODEL=gpt-4o
   LLM2_API_KEY=sk-...
   ```
   (LLM1 router vars are optional — see [`../.env.minimal.example`](../.env.minimal.example);
   full reference in [`../.env.example`](../.env.example).)
5. **Start.** First boot downloads Python + ffmpeg + deps (a minute or two,
   cached afterwards), then runs both processes.

---

## Pairing

Watch the console after starting:

- With `WA_PAIRING_NUMBER` set, a pairing code appears:
  ```
  ================ WhatsApp Pairing Code ================
    Number : 6281234567890
    Code   : ABCD-EFGH
    Steps  : WhatsApp > Linked Devices > Link a Device >
             Link with phone number  →  enter the code above
  ======================================================
  ```
  Enter it on the bot's phone. (The code rotates if unused; restart to mint a
  fresh one.)
- Without it, a QR is rendered in the console instead — scan it.

Once linked you'll see `WhatsApp socket connected`. The session is saved, so you
only pair once.

---

## Notes & limitations

- **ffmpeg is best-effort.** Only needed for `/sticker` *video→webp*. If the
  image lacks `xz` to unpack the static build, the bootstrap logs a warning and
  the bot keeps running (static-image stickers and everything else still work).
  You can point `FFMPEG_STATIC_URL` at a `.tar.gz` static build instead.
- **Network on first boot** fetches Python from
  [`astral-sh/python-build-standalone`](https://github.com/astral-sh/python-build-standalone/releases)
  and ffmpeg from johnvansickle. Override with `PBS_RELEASE` / `PYTHON_VERSION`
  / `FFMPEG_STATIC_URL` env vars if an asset ever 404s.
- **Updating:** the generic egg `git pull`s on each start; the bootstrap re-uses
  the cached Python/ffmpeg. Your `data/` and `.env` are preserved.
- **Port.** The server's primary allocation is used as the internal WS port
  (loopback only) — nothing needs to be reachable from outside.

---

## Re-pairing / resetting the WhatsApp session

If the bot gets logged out, you switch numbers, or auth gets corrupted: **Stop**
the server, then in the **Files** tab delete the `data/auth` folder, and
**Start** again. A fresh pairing code / QR appears. Your settings and chat data
in the other `data/` files are kept.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| **No pairing code / QR in the console** | The code only appears while the device is *unregistered*. If already paired, nothing shows (that's normal). To force a new code, re-pair (above). Check `WA_PAIRING_NUMBER` is digits-only with country code. |
| **`better-sqlite3` build error / `compiled against a different Node.js version`** | The chosen Node version has no prebuilt binary. Switch the Docker Image to **`nodejs_22`** (or `nodejs_20`) and restart. |
| **Bot connects but never replies** | The Python bridge isn't running or has no LLM key. Check the console for `[bootstrap] WARN: ... Python ...`, and confirm `LLM2_API_KEY` (plus `LLM2_ENDPOINT`/`LLM2_MODEL`) are set in `.env`. |
| **Python deps failed on first boot** | Usually a transient network error fetching wheels. Restart to retry; the cache marker is only written on success. If a Python asset 404s, set `PBS_RELEASE` / `PYTHON_VERSION` to a valid [python-build-standalone](https://github.com/astral-sh/python-build-standalone/releases) release. |
| **`/sticker` from a video fails** | ffmpeg isn't available. Static-image stickers still work. Set `FFMPEG_STATIC_URL` to a `.tar.gz` static build the image can unpack. |
| **Changes to `.env` not taking effect** | Restart the server — `.env` is read at process start. |
| **Want to update the app** | Just **Restart** (the egg `git pull`s on boot). Your `data/` and `.env` are preserved. |
