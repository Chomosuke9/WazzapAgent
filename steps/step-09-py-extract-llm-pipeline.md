# Step 09 — Extract LLM pipeline (`Llm1Router`, `Llm2Responder`) + consolidate prompts
**Phase:** 3 · **Risk:** high · **Depends on:** step-08

## Goal
Lift the LLM1 routing and LLM2 generation/validation logic out of the
`session.py` closures into injectable collaborator classes, and move all prompt
assembly into `llm/prompt.py`.

## Why (audit — High #2, Medium #6)
The LLM1/LLM2 flow is buried in `process_message_batch` (session.py 667–2278,
nested up to 11 levels). Prompt assembly is duplicated/split between `llm2.py`
(`_render_system_prompt`/`_load_system_prompt`/`_chat_state_header`, 147–319) and
`prompt.py`, with `session.py` importing prompt helpers from `llm2` at runtime.
The flow is not unit-testable because logic-in-closures + hard-imported globals
(`call_llm1`/`generate_reply`) can't be mocked in isolation.

## Changes
- `bridge/agent/llm1_router.py` — `Llm1Router`: owns the should-respond/express
  decision; constructor takes the LLM1 client + config; method returns a typed
  decision object. Wraps `llm/llm1.py` calls.
- `bridge/agent/llm2_responder.py` — `Llm2Responder`: owns reply generation +
  `_validate_llm2_result` (session.py 1335); constructor takes the LLM2 client +
  tool schemas; returns the generated actions/text. `llm2.py` is reduced to
  generation primitives.
- Move `_render_system_prompt`/`_load_system_prompt`/`_chat_state_header` and any
  prompt helpers out of `llm2.py` into `llm/prompt.py`; `Llm2Responder` and
  `session.py` import prompt assembly from one place.
- `AgentSession` constructs `Llm1Router`/`Llm2Responder`; the batch closure calls
  them via `self`.
- Unit tests with fake LLM clients (assert routing/generation/validation without
  network).

## OOP / target
Routing and generation are separate injectable services with explicit clients;
prompt assembly has one home. The pipeline is testable with fakes.

## Must NOT
- Must NOT change prompts, model selection, tool schemas, or LLM behavior.
- Must NOT change the LLM1-skip-in-private-chat or confidence semantics.

## Verification
- Python gates green; new `Llm1Router`/`Llm2Responder` unit tests pass.
- `git grep -n "from .*llm2 import .*prompt\|_render_system_prompt" python/bridge`
  shows prompt assembly only in `llm/prompt.py`.

## Done when
- LLM1/LLM2 logic lives in collaborator classes; prompt assembly consolidated;
  gates green.
