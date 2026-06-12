# Two-account end-to-end smoke

This is the reproducible end-to-end procedure for the **reversed multi-account
topology**: the Node gateway is the WebSocket **server** and the Python
`WaSocket` clients **dial** it (`hello`/`hello_ack` handshake, CONTRACT.md §1),
each bound to its own tenant `folder_path` with the layout
`<folder_path>/{auth,db,media,stickers}` (CONTRACT.md §8).

There are two layers:

1. **Scripted smoke** (`tests/e2e/two_account_smoke.py`) — the automated proof
   of two-account boot + isolation. It runs against a **stub Node server**
   because this sandbox has **no real WhatsApp pairing and no LLM credentials**.
2. **Manual staging procedure** — the full real-WhatsApp end-to-end, run by an
   operator against a real Node server and two paired WhatsApp accounts.

---

## 1. Scripted smoke (automated, no real WhatsApp / no LLM)

The script boots **two** stub Node servers (one per tenant) and **two**
`WaSocket` + `AgentSession` pairs against two distinct `folder_path`s, then
asserts:

- both sockets complete the `hello`/`hello_ack` handshake and reach `ready`
  (CONTRACT §1.1);
- a settings write made "as account A" lands **only** in `A/db/settings.db` and
  one made "as account B" lands **only** in `B/db/settings.db` — no per-tenant
  DB cross-talk (CONTRACT §8);
- an `incoming_message` pushed to each account is delivered **only** to that
  account's socket — no message routing cross-talk;
- `build_session` assigns each account a distinct sub-agent webhook port
  (`base + index`, index 0 == configured base).

### Run it

The script is **not** a pytest module — it is driven by `asyncio.run` under a
hard `wait_for` ceiling, with every await bounded and all servers/sockets torn
down in `finally`. Always wrap it in a hard kill timeout:

```bash
# Use an interpreter that has the `websockets` package (see Prerequisites).
timeout --signal=KILL 60 python3 tests/e2e/two_account_smoke.py
echo "EXIT=$?"   # 0 == all assertions passed
```

Expected tail:

```
[ok] build_session assigns distinct base+index webhook ports
[ok] both accounts booted and reached ready (hello/hello_ack)
[ok] per-tenant settings.db isolation: no DB cross-talk
[ok] per-account message routing isolation: no message cross-talk

TWO-ACCOUNT E2E SMOKE: PASS
EXIT=0
```

### Prerequisites

- Python 3.10+ with the bridge deps importable (`websockets`, plus what
  `python/bridge` imports). If your default `python3` lacks
  `websockets`, use the project's pyenv interpreter, e.g.
  `~/.pyenv/versions/3.12.13/bin/python3`.
- No network, no LLM keys, no WhatsApp pairing required — the stub server
  supplies canned `hello_ack` / `action_ack` responses.

### No-hang discipline

A prior step hung for hours, so this smoke follows strict rules:

- no `pytest-asyncio` — `asyncio.run` only;
- every `await` is bounded by `asyncio.wait_for`;
- stub servers bind **ephemeral** ports (port 0) and disable library keepalive;
- sockets use a far-future heartbeat + tiny reconnect base;
- run tasks and servers are awaited-down in `finally`.

After running, confirm there are no orphans:

```bash
ps -eo pid,comm,args | grep -iE "two_account_smoke|stub_node|wsServer" | grep -v grep || echo NO-ORPHANS
```

### Related coverage

`python/tests/test_multi_account.py` covers the same two-account
boot + per-tenant DB isolation + distinct-webhook-port invariants as a unit
test (also `asyncio.run`, no pytest-asyncio). The e2e script is the
fresh-clone, single-command proof; the unit test is the in-suite regression
guard.

---

## 2. Manual staging procedure (full real-WhatsApp e2e)

Run on a staging host with two real WhatsApp numbers and real LLM credentials.
This is **manual** by design — pairing requires scanning a QR per account.

### 2.1 Configure

`.env` (see `.env.example`):

```dotenv
# Node serves here; Python dials it.
WS_LISTEN_PORT=3000
NODE_URL=ws://localhost:3000

# Two tenants. Each gets <folder_path>/{auth,db,media,stickers} (CONTRACT §8).
FOLDER_PATHS=./tenants/acct-a,./tenants/acct-b

# LLM creds for the bridge's response pipeline.
LLM2_ENDPOINT=...
LLM2_API_KEY=...
```

### 2.2 Boot order (server first, then clients)

```bash
# 1) Start the Node gateway (WS SERVER). It listens on WS_LISTEN_PORT and
#    creates/resumes a Baileys socket per tenant folder_path.
pnpm dev

# 2) Start the Python bridge. It loads the accounts config and dials NODE_URL
#    once per tenant, sending `hello { folderPath }` and awaiting `hello_ack`.
python -m bridge.main      # from python
```

### 2.3 Pair / resume

- On first boot each tenant prints a QR in the Node logs. Scan
  `tenants/acct-a` with phone A and `tenants/acct-b` with phone B.
- Auth is stored under each tenant's `auth/`. On restart each account
  **resumes** independently (no re-pairing) — `hello_ack.waStatus` goes
  `connecting` → `open`.

### 2.4 Assert isolation

- Send a message to a group on account A → only account A's bridge processes
  it; account A's reply is sent by account A's WhatsApp number.
- Repeat for account B. Confirm **no cross-talk**: A never replies in B's chats
  and vice-versa.
- Inspect on-disk state: `tenants/acct-a/db/settings.db` contains only A's
  chats; `tenants/acct-b/db/settings.db` only B's (CONTRACT §8).
- Deleting `tenants/acct-a/auth/` forces only account A to re-pair; account B
  is unaffected.

### 2.5 Teardown

Stop the Python bridge (Ctrl-C — it flushes/checkpoints DBs and disconnects
each WaSocket), then stop the Node server.

---

## CONTRACT cross-references

- **§1** — `hello`/`hello_ack` handshake; actions Python→Node; events,
  control events and acks Node→Python; `WaStatus = "open" | "connecting" | "close"`.
- **§4** — `make_wa_socket(folder_path) -> WaSocket`; `connect(node_url=...)`.
- **§8** — per-tenant `<folder_path>/{auth,db,media,stickers}` layout and
  per-tenant DBs.
