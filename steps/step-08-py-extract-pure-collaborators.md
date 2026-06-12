# Step 08 — Extract pure collaborators + `media/` from `session.py`
**Phase:** 3 · **Risk:** med · **Depends on:** step-07

## Goal
Begin decomposing the `session.py` god-function with the lowest-risk, most
self-contained pieces first: `MuteGate`, `IdleTrigger`, `ReplyDedup`, and a
`bridge/media/` module for the media/sticker resolution helpers. Introduce
dependency-injection seams in `AgentSession.__init__` so later steps can plug in
the bigger collaborators.

## Why (audit — High #2)
`session.py` is 3,027 lines. `AgentSession` is a cosmetic shell (4 bookkeeping
methods); all logic lives in closures inside `_register_handlers` (571–2604).
Eight module-level media/sticker helpers sit at the top (193–440). Pure,
side-effect-light logic (`_compute_idle_trigger` at 440, `_is_duplicate_reply`
at 637, mute checks) is trivially extractable and immediately unit-testable.

## Changes
- `bridge/media/` — move `_parse_sticker_args`, `_store_media_path`,
  `_cleanup_stale_media_paths`, `_resolve_quoted_media_attachments`,
  `_guess_mime_from_path`, `_resolve_sticker_media`,
  `_append_sticker_log_to_history` (session.py 193–440) into a cohesive module
  (these can be functions or a `MediaResolver` class holding the per-chat
  media-paths dict).
- `bridge/agent/idle_trigger.py` — `IdleTrigger` wrapping `_compute_idle_trigger`
  + `_should_idle_trigger` (session.py 440/659).
- `bridge/agent/reply_dedup.py` — `ReplyDedup` wrapping `_is_duplicate_reply`
  (637) + its dedup window/state.
- `bridge/agent/mute_gate.py` — `MuteGate` encapsulating the inbound mute check.
- `AgentSession.__init__` constructs these as instance attributes; the closures
  in `_register_handlers` call `self._idle`, `self._dedup`, etc. instead of the
  inline logic.
- Unit tests for each extracted collaborator (no socket/LLM needed).

## OOP / target
Each collaborator owns one concern + its own state, constructed with explicit
deps. `AgentSession` starts becoming a composition root.

## Must NOT
- Must NOT change debounce/dedup/idle/mute behavior or thresholds.
- Must NOT yet touch the LLM1/LLM2/batch/subagent flow (steps 09–10).

## Verification
- Python gates green (`PYTHONPATH=python … pytest python/tests` no new failures).
- New collaborator unit tests pass under a hard timeout.

## Done when
- `MuteGate`/`IdleTrigger`/`ReplyDedup` + `media/` extracted with tests;
  `session.py` shrinks accordingly; gates green.
