# Step 34 — Docs, env, and end-to-end — Verification Report

## (1) Verdict: PARTIAL

The reversed-topology / multi-account documentation (README.md, AGENTS.md) and
the two-account end-to-end smoke (`tests/e2e/two-account.md` +
`tests/e2e/two_account_smoke.py`) are present, coherent, and consistent with
CONTRACT.md §1/§4/§8. However, `.env.example` **removed** `LLM_WS_ENDPOINT`
entirely instead of deprecating it, which fails an explicit acceptance
criterion AND violates a "Must NOT do" rule.

---

## (2) Acceptance-criteria checklist

| # | Criterion | Result |
|---|-----------|--------|
| 1 | `grep "WS_LISTEN_PORT\|node_url\|NODE_URL"` shows new keys in README.md, AGENTS.md, .env.example | **PASS** — all three files contain `WS_LISTEN_PORT` and `NODE_URL`; `.env.example` and README also document per-account `node_url`. |
| 2 | `grep "deprecated" .env.example` flags `LLM_WS_ENDPOINT` | **FAIL** — `.env.example` contains neither `LLM_WS_ENDPOINT` nor the word "deprecated". The key was deleted (Init commit `d72f0f3` had `LLM_WS_ENDPOINT=ws://localhost:8080/ws` on line 4; it is absent in HEAD). |
| 3 | Two-account e2e (`tests/e2e/two-account`) passes | **PASS (static)** — `two-account.md` documents the procedure; `two_account_smoke.py` references only real symbols (`build_session(account, index)`, `AgentSession.tenant_db/register/run/folder_path/subagent_webhook`, `make_wa_socket(folder, base_ms=..., max_ms=..., jitter_ratio=..., heartbeat_interval_ms=..., ack_timeout=...)`, `db.set_permission`, `SUBAGENT_WEBHOOK_PORT`, `StubNodeServer.start/stop/wait_connected/push_incoming_message`, `WaSocket.is_connected` property). Asserts per-tenant DB + message-routing isolation and distinct `base+index` webhook ports. Not executed per read-only/no-hang rules. |
| 4 | Fresh-clone walkthrough boots Node server + ≥1 WaSocket client | **PASS** — README Quick Start gives correct boot order (Node `pnpm dev` first, then `python -m bridge.main` from `migration/python`), env keys, and per-tenant folder layout. |
| 5 | No doc statement contradicts CONTRACT §1/§4/§8 | **PASS** — README/AGENTS describe Node-as-server, Python WaSocket clients dialing `NODE_URL`, `hello`/`hello_ack` (reliable), best-effort `incoming_message`, reliable control events, top-level `folderPath`, and `<folder_path>/{auth,db,media,stickers}` consistent with the contract. |

---

## (3) Issues

- **[MAJOR] .env.example** — `LLM_WS_ENDPOINT` was deleted instead of being kept
  and marked deprecated. This fails acceptance criterion #2
  (`grep "deprecated" .env.example` must flag `LLM_WS_ENDPOINT`) and directly
  violates the "Must NOT do" rule: *"Do not remove `LLM_WS_ENDPOINT` from
  `.env.example` (deprecate, keep for backward-compat reference)."* Confirmed
  via git: Init commit `d72f0f3:.env.example` line 4 had
  `LLM_WS_ENDPOINT=ws://localhost:8080/ws`; HEAD has no occurrence.

- **[MINOR] AGENTS.md (Build/Test commands section)** — references
  `python -m python.bridge.main` (the old `python/` tree) while README and the
  e2e doc use the correct migration invocation `python -m bridge.main` (from
  `migration/python`). Minor doc inconsistency; the canonical Quick Start in
  README is correct.

---

## (4) "Must NOT do" / isolation / contract notes

- **VIOLATED — "Do not remove `LLM_WS_ENDPOINT` from `.env.example`"**: see
  MAJOR issue above. (The intent — deprecate, do not delete — was not met.)
- **"Do not introduce config keys not used by the code"**: NOT violated. All
  new keys are consumed: `WS_LISTEN_PORT` (migration/node/config.ts,
  server/wsServer.ts), `NODE_URL`/`FOLDER_PATHS`/`ACCOUNTS_JSON`/`FOLDER_PATH`
  (migration/python/bridge/accounts.py + main.py).
- **"Do not change runtime behavior or the wire protocol"**: NOT violated —
  this step only touched docs/env and added a non-suite e2e script (driven by
  `asyncio.run`, ephemeral ports, bounded `wait_for`, full teardown in
  `finally`), with no source/protocol changes.
- **Isolation**: the e2e correctly asserts per-tenant DB isolation (writes land
  only in the owning tenant's `db/settings.db`), per-account message routing
  isolation, and distinct `base+index` sub-agent webhook ports — matching the
  multi-account isolation contract.

---

### What was checked
Read the full step spec, `.env.example`, both e2e files, and cross-checked
README/AGENTS against CONTRACT.md §1/§4/§8. Verified every symbol referenced by
`two_account_smoke.py` exists with matching signatures, and confirmed the new
env keys are read by migration code. Confirmed via git history that
`LLM_WS_ENDPOINT` previously existed in `.env.example` and was removed.
