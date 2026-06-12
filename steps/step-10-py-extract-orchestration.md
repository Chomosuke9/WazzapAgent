# Step 10 — Extract `BatchProcessor`/`EventRouter`/`AckHydrator`/`SubAgentCoordinator`
**Phase:** 3 · **Risk:** high · **Depends on:** step-09

## Goal
Finish the `session.py` decomposition: move the remaining orchestration out of
the closures so `AgentSession` becomes a thin composition root that wires
collaborators and registers SDK handlers.

## Why (audit — High #2)
After steps 08–09, the residue in `_register_handlers` is still the batch
orchestrator (`process_message_batch`), control-event routing, ack hydration,
and subagent submit/post-process/correction. These are distinct responsibilities
co-located in one function and must become separate classes for clarity and
testability.

## Changes
- `bridge/agent/batch_processor.py` — `BatchProcessor`: debounce/burst assembly,
  prefix-interrupt, and the per-batch pipeline orchestration (calls `MuteGate`,
  `Llm1Router`, `Llm2Responder`, dispatch). This replaces the body of
  `process_message_batch`.
- `bridge/agent/event_router.py` — `EventRouter`: handles control events
  (`clear_history`, `set_llm2_model`, `invalidate_*`, `set_subagent_enabled`).
- `bridge/agent/ack_hydrator.py` — `AckHydrator`: provisional→real contextMsgId
  hydration on `action_ack` (consolidate with `messaging/ack_handler.py`).
- `bridge/agent/subagent_coordinator.py` — `SubAgentCoordinator`: submit,
  webhook wait, post-process, correction re-dispatch, steering.
- `AgentSession`: `__init__` builds all collaborators with explicit deps;
  `register()` wires SDK `on(...)` handlers to thin methods that delegate. Remove
  `_register_handlers`'s nested-closure logic. Target: `session.py` well under a
  few hundred lines.
- Collaborator unit tests with fakes (batch pipeline, event routing, hydration).

## OOP / target
`AgentSession` = composition root only. Each collaborator is independently
testable. No business logic in closures; no nested depth beyond normal methods.

## Must NOT
- Must NOT change batching/debounce, subagent, hydration, or event semantics.
- Must NOT reintroduce module-level mutable per-account state (keep it on
  instances).

## Verification
- Python gates green; full `pytest python/tests` no new failures; new
  collaborator tests pass.
- `wc -l python/bridge/session.py` is dramatically reduced; no function over
  ~100 lines remains in it.

## Done when
- All four collaborators extracted; `AgentSession` is a composition root; gates
  green.
