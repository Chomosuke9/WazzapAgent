# Step 25 — `wasocket/correlation.py` — Verification Report

## 1. Verdict: ACCURATE

The module `migration/python/wasocket/correlation.py` exists, exports exactly
what the spec requires, ports the legacy `request_id` format verbatim, and the
companion test file covers every acceptance criterion. Behaviour confirmed by an
isolated bounded import/run (module imports cleanly without `websockets`; format,
monotonic seq, resolve, timeout→`code="timeout"`, and no-op all confirmed).

## 2. Acceptance-criteria checklist

| Criterion | Result | Evidence |
|-----------|--------|----------|
| `make_request_id("send")` matches `^send-\d{13}-\d{6}$`; two calls strictly increasing `seq6` | PASS | `make_request_id` returns `f"{tag}-{int(time.time()*1000)}-{next(_counter):06d}"`; module-global `itertools.count(1)`. Verified at runtime (`fmt True True`). Test: `test_make_request_id_format_and_monotonic_seq`. |
| `register` then `resolve` resolves the future with the result dict | PASS | `resolve` pops + `set_result(result)`. Runtime: `resolve {'ok': 1}`. Test: `test_register_then_resolve_resolves_with_result`. |
| `register(timeout=0.05)` with no resolve → future raises `TimeoutError` (`code=="timeout"`) | PASS | `_on_timeout` sets `errors.TimeoutError(..., code="timeout", request_id=...)`. Runtime: `timeout code timeout`. Test: `test_register_timeout_rejects_with_timeout_error`. |
| `resolve` on unknown/expired id is a no-op | PASS | `_pop` returns `None` → guard `if future is None ... return`. Runtime: `noop ok`. Tests: `test_resolve_unknown_id_is_noop`, `test_resolve_cancels_timeout_no_late_rejection`. |
| `reject_all` rejects all outstanding futures | PASS | Snapshots `list(self._futures.keys())`, pops each (cancels timer), `set_exception`. Test: `test_reject_all_rejects_outstanding_futures` asserts `["send_failed","send_failed"]`. |
| `python -c "import python.wasocket.correlation"` imports cleanly | PASS (module clean; see note) | correlation.py imports only `asyncio`, `itertools`, `time`, `.errors`. Direct isolated import succeeds. In this audit env the *package* `__init__` fails only because `websockets` is not installed (pulled in by `socket`/`transport` from other steps) — not a Step-25 defect; the orchestrator's gate env has `websockets`. |

## 3. Files

- Create `migration/python/wasocket/correlation.py` — EXISTS, matches purpose/exports.
  - `make_request_id(tag)` — verbatim legacy format (cf. `processing.py:711-712`
    `f"{action}-{int(time.time()*1000)}-{next(REQUEST_COUNTER):06d}"`). Match.
  - `class PendingAcks` with `register`, `resolve`, `reject`, `reject_all` — all present
    with correct signatures (`register(request_id, *, timeout=30.0) -> asyncio.Future`).
- Modify: None (correct — `processing.py` still owns its own `_make_request_id`/`REQUEST_COUNTER`; `session.py`/`gateway.py` still use it).
- Delete: None (correct).

## 4. Issues

None of BLOCKER/MAJOR severity.

- [MINOR] correlation.py — `make_request_id` is not yet referenced anywhere
  (the bridge keeps its own `_make_request_id` until Step 28, as the spec states).
  This is expected dead-until-wired code, not a defect.

## 5. Must-NOT-do / contract / isolation notes

- "Do not change the `request_id` format from CONTRACT.md §3" — NOT violated.
  Format is a verbatim port; matches `^<tag>-\d{13}-\d{6}$` and CONTRACT §3 example.
- "Do not import `websockets` or open sockets" — NOT violated. Only `asyncio`,
  `itertools`, `time`, `.errors` imported. No socket/frame/event-dispatch code.
- "Do not modify `processing.py` yet" — NOT violated (`git status` shows
  `processing.py` unchanged; only `bridge/main.py` shows as modified, unrelated
  to this step and not touched by this audit).
- Teardown/leak check: `_pop` cancels the per-request `TimerHandle` on
  resolve/reject; `_on_timeout` pops without cancel (timer already fired);
  `reject_all` pops each (cancelling timers). No timer leak; resolve cancels the
  expiry so no late `InvalidStateError` (covered by
  `test_resolve_cancels_timeout_no_late_rejection`).
- Isolation: counter is intentionally process-global/shared across sockets per
  CONTRACT §3 — correct by design. `PendingAcks` is per-instance state (own
  `_futures`/`_timers` dicts), so no cross-tenant leakage between sockets.
- `errors.TimeoutError` accepts `request_id=` (defined in `errors.py`
  `WaSocketError.__init__`), so the timeout rejection carries the correlating id.

## Methodology
Read the full spec, CONTRACT §2 (error codes) and §3 (request_id format/expiry),
the legacy reference `processing.py` (`_make_request_id`/`REQUEST_COUNTER`),
`errors.py` (Step 22), the implemented `correlation.py`, and the test file.
Ran one bounded (`timeout --signal=KILL 30`) isolated import + behaviour check
confirming format, monotonicity, resolve, timeout code, and no-op. Read-only;
no source/test/config files modified.
