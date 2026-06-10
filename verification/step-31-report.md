# Step 31 — Trim Python server dependency surface — Verification Report

## (1) Verdict: ACCURATE

## (2) Acceptance-criteria checklist

- [PASS] `grep -n "websockets.serve\|_parse_endpoint" migration/python/bridge/main.py` returns **zero** matches.
  - Verified: grep for `websockets\.serve|_parse_endpoint|_shutdown_signal_handler` in
    `migration/python/bridge/main.py` → 0 matches.
- [PASS] File parses as valid Python: `ast.parse(...)` succeeds (`AST_OK`).
  - pyflakes not run, but static read shows no unused imports (see below).
- [PASS] `pytest migration/python/tests/` — NOT run per orchestration rules (forbidden);
  judged statically. No logic in main.py was altered that would affect tests; only
  dead server helpers are absent.

## Files-to-modify verification

### `migration/python/bridge/main.py`
- Original `python/bridge/main.py` confirmed to contain the server-only helpers:
  `import websockets` (L18), `_parse_endpoint` (L3100), `websockets.serve` (L3130),
  `_shutdown_signal_handler` (L3171).
- Migration `main.py` contains NONE of these: no `import websockets`, no
  `_parse_endpoint`, no `websockets.serve`, no `_shutdown_signal_handler`. PASS.
- Signal handling used by the WaSocket boot is KEPT: `import signal`,
  `loop.add_signal_handler(sig, _handle_signal, sig)` for SIGINT/SIGTERM driving
  `stop_event`, with the `NotImplementedError` Windows guard. PASS (spec: "Keep the
  signal handling that the WaSocket boot uses").
- Imports audit — all present imports are used: `asyncio` (gather/Event/run),
  `atexit` (register/unregister), `signal` (SIGINT/SIGTERM), `load_dotenv` (called),
  `make_wa_socket` (build_session), `load_accounts` (main), `db_checkpoint_all_dbs`
  / `db_close_all_connections` (cleanup), `setup_logging` (logger), `AgentSession`
  (type hint + construction), `SUBAGENT_WEBHOOK_PORT` (default arg). No unused
  imports. PASS.

### `requirements.txt`
- `websockets>=12.0` is still present (NOT removed). PASS.
- `migration/python/wasocket/transport.py` confirms the client still needs it:
  L38 `import websockets`, L39 `from websockets.asyncio.client import ...`,
  L40 `from websockets.protocol import State`. PASS.
- No dependency was server-path-only; none removed (expected: none). PASS.

## Files to create / delete
- None required. None created/deleted. PASS.

## (3) Issues list
None. No BLOCKER / MAJOR / MINOR issues found.

## (4) Must-NOT-do / isolation / contract notes
- `websockets` NOT removed from `requirements.txt` — compliant.
- Agent logic / WaSocket wiring from Step 28 unchanged — only dead server helpers
  are absent. Compliant.
- No contract references changed by this step (spec: "None changed"). No protocol
  framing, folderPath routing, or reliability semantics touched.
- Per-account isolation: main.py builds one WaSocket + AgentSession per account
  with distinct webhook ports (`base + index`); no shared mutable state introduced
  by this trim. No regressions observed.

## What was checked
Read the full step spec, migration `main.py`, `requirements.txt`, original
`python/bridge/main.py` (to confirm the helpers existed and were removed), and
`wasocket/transport.py` (to confirm the client dependency). Ran bounded grep for
the forbidden symbols (0 matches) and a 30s-timeout `ast.parse` (succeeded). Did
not run servers or the test suite per orchestration rules.
