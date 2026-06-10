# Step 22 Verification — `wasocket/errors.py`

## 1. Verdict: ACCURATE

The implementation at `migration/python/wasocket/errors.py` fully satisfies the
Step 22 spec and matches CONTRACT.md §2 / §1.3 and the Node-side error codes.

## 2. Acceptance-criteria checklist

| Criterion | Result |
|-----------|--------|
| File `migration/python/wasocket/errors.py` exists | PASS |
| `class WaSocketError(Exception)` base carrying `code`, `detail`, `request_id`, `action` | PASS (errors.py:24-77) |
| 6 subclasses: `NotFoundError`, `NotGroupError`, `PermissionDeniedError`, `InvalidTargetError`, `SendFailedError`, `TimeoutError` | PASS (errors.py:80-138) |
| Each subclass `code` exactly equals CONTRACT.md §2 string | PASS — `not_found`, `not_group`, `permission_denied`, `invalid_target`, `send_failed`, `timeout` (verified vs CONTRACT.md §2 lines 304-310) |
| `from_error_frame(payload)` builds right subclass from `error` frame | PASS (errors.py:160-172); reads `code`/`detail`/`message`/`requestId`/`action` |
| `from_failed_ack(payload)` builds from `action_ack` `ok=false` | PASS (errors.py:175-185) |
| `CODE_TO_CLASS` mapping table present | PASS (errors.py:141-149) |
| Unknown/missing code → base `WaSocketError` (preserving code) | PASS (errors.py:151-158, `_build`); runtime-verified `{"code":"weird"}` → base with code `weird` |
| `import` of module clean (dependency-free) | PASS — isolated file import succeeds (only `typing` + `__future__`) |
| Each code round-trips via `from_error_frame` to correct subclass | PASS (runtime-verified) |
| `from_failed_ack({"ok":False,"code":"not_found"})` → `NotFoundError` | PASS (runtime-verified) |
| Every subclass `is`/issubclass of `WaSocketError` | PASS (runtime-verified) |

Runtime check (isolated `spec_from_file_location` load, bounded `timeout 30`):
imports clean; all six codes mapped; unknown→base `WaSocketError(code='weird')`;
`from_failed_ack` not_found→`NotFoundError`; `TimeoutError` subclass of base.

## 3. Issues

- [MINOR] AcceptanceCriteria vs reality — the criterion `python -c "import
  python.wasocket.errors"` now transitively triggers `wasocket/__init__.py`
  (replaced in Step 27), which imports `socket.py`/`transport.py` and therefore
  `websockets`/`asyncio`. So that one-liner only "imports cleanly" if those deps
  are installed. This is NOT a Step 22 defect — `errors.py` itself is strictly
  dependency-free and imports cleanly in isolation. Noted only as a stale
  acceptance-criterion wording caused by a later step.

No BLOCKER or MAJOR issues found.

## 4. Must-NOT / isolation / contract notes

- "Do not import `websockets`/`asyncio`" — PASS. Only `from __future__ import
  annotations` and `from typing import Dict, Optional, Type`.
- "Do not define dataclasses for frames" — PASS. No dataclasses; pure exception
  classes.
- "Do not wire into the bridge" — PASS. Files to modify = None; `errors.py`
  imports nothing from the bridge. (`__init__.py` re-exports the error classes,
  but that re-export was done by Step 27, not Step 22.)
- Contract parity — PASS. The six code strings exactly match CONTRACT.md §2 and
  the Node producer side (`migration/node/account/actionDispatcher.ts`
  `actionErrorCode`, `wa/actions.ts`, `wa/moderation.ts`, `wa/outbound.ts`,
  `mediaHandler.ts`, `wa/utils.ts` → `timeout`). `from_error_frame` also reads
  `message` as a detail fallback, consistent with the `error` frame shape
  (CONTRACT.md §1.3 carries both `message` and `detail`).
- No per-account/tenant state, no sockets/intervals — leaf module, nothing to
  tear down. No isolation concerns.
- Companion test `migration/python/tests/test_errors.py` exists and covers all
  required cases (per-code round-trips, unknown→base, failed_ack, subclass
  checks, `__str__`, explicit-code override).
