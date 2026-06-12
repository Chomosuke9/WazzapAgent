# Step 10b — Decompose the `process_message_batch` pipeline
**Phase:** 3 · **Risk:** high · **Depends on:** step-10

## Goal
Break `BatchProcessor.process_message_batch` (~1000 lines, lines ~205–1271 of
`python/bridge/agent/batch_processor.py`, with a deeply nested `_log_slow_batch`
and many inner closures) into named, single-purpose phase methods on
`BatchProcessor`. Behavior, async timing, and ordering must stay identical.

## Why
Step 10 correctly extracted the collaborator classes and reduced `session.py` to
a 449-line composition root, but it RELOCATED the batch god-function into
`BatchProcessor` largely verbatim rather than decomposing it. The audit's #1
Python finding was specifically that this pipeline is a single ~1600-line
function nested up to 11 levels deep. Moving it to a new file does not fix the
readability/testability problem — the method must be split into phases.

## Changes
Within `BatchProcessor`, split `process_message_batch` into private phase
methods, each with a clear contract, e.g. (adapt names to the real flow):
- `_assemble_burst(...)` — debounce/burst collection + stale-batch discard.
- `_check_gates(...)` — activation/mute/command-handled gating.
- `_run_llm1(...)` — routing decision + prefix-interrupt handling (delegates to
  `Llm1Router`).
- `_run_llm2(...)` — generation + validation (delegates to `Llm2Responder`).
- `_dispatch_actions(...)` — tool-call/action dispatch incl. `execute_subtask`
  delegation to `SubAgentCoordinator`.
- `_finalize(...)` — dedup record, history hydration, slow-batch logging.
Lift `_log_slow_batch` and other inner closures to methods/helpers where they no
longer need closure state, or pass state explicitly. Keep per-chat locks and the
hybrid prefix-interrupt cancellation semantics EXACTLY as they are.

## OOP / target
`process_message_batch` becomes a short orchestrator (<~80 lines) calling the
phase methods in order. No method over ~120 lines. Nesting depth ≤ ~4.

## Must NOT
- Must NOT change debounce windows, prefix-interrupt cancellation, per-chat
  locking, background-task scheduling, action output, or wire frames.
- Must NOT change the LLM1/LLM2/subagent semantics (only restructure the
  orchestration around them).

## Verification
- Python full suite no new failures beyond the 20 env baseline; the flow tests
  (test_batch_processor, test_agent_session, test_idle_trigger, test_bug_fixes,
  test_hydration, test_subagent_output, test_multi_account) all pass.
- Import sanity ok. Confirm (by inspection) no method in `batch_processor.py`
  exceeds ~120 lines and `process_message_batch` is a short orchestrator.

## Done when
- The pipeline is phase-decomposed, behavior identical, gates green.
