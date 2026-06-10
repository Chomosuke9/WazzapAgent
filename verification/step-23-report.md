# Step 23 Verification — `wasocket/protocol.py`

## (1) Verdict: ACCURATE

The implementation at `migration/python/wasocket/protocol.py` faithfully mirrors
CONTRACT.md §6 field-for-field, implements the §1 wire shapes (payload-wrapped
actions/acks/events vs top-level §1.5 control events), and contains no socket /
asyncio / request_id-generation code. All spec claims verified by static reading
plus a bounded, read-only direct-module round-trip script.

## (2) Acceptance-criteria checklist

- PASS — `round-trip decode(encode(x)) == x` for every action and event dataclass.
  Verified: `test_protocol.py::ROUND_TRIP_INSTANCES` covers all 23 §6 classes;
  manually confirmed round trips for Hello, SendMessageAction (with attachments),
  KickMemberAction (tuple targets restored), SetLlm2ModelEvent(model_id=None),
  MarkReadAction, SendCarouselAction, AckResult. `type(parsed) is type(frame)`.
- PASS — golden JSON samples (gateway.py / CONTRACT §1) decode without field loss.
  `GOLDEN_ACTIONS`/`GOLDEN_ACKS` cover all 13 actions + action_ack + error;
  collection fields (targets/choices/attachments) preserved.
- PASS — control event (`clear_history`) encodes with `chatId`/`folderPath` at the
  TOP LEVEL, no `payload` key. Confirmed manually: `{"type","folderPath","chatId"}`,
  `"payload" not in obj`. Actions correctly remain payload-wrapped.
- PASS — camelCase↔snake_case verified on `SendMessageAction` (`reply_to`→`replyTo`,
  `request_id`→`requestId`, `chat_id`→`chatId`); centralized helpers
  `snake_to_camel`/`camel_to_snake` correct for all tested fields incl.
  `auto_reply_anchor`, `quoted_preview_text`, `wa_status`, `model_id`,
  `context_msg_id`, `protocol_version`.
- PASS (with env caveat) — protocol module imports cleanly in isolation (only
  `dataclasses`, `json`, `re`, `typing`). NOTE: the spec's literal
  `python -c "import python.wasocket.protocol"` goes through `wasocket/__init__.py`,
  which imports `socket`→`transport`→`websockets`; without `websockets` installed
  that chain fails. This is a package-wiring/env concern (Step 22/dep install),
  NOT a defect in protocol.py itself, which is fully self-contained.

## (3) Issues list

- [MINOR] migration/python/wasocket/__init__.py:25 — Importing the protocol module
  via the package (`wasocket.protocol` / `python.wasocket.protocol`) transitively
  imports `websockets` through `socket.py`/`transport.py`. The acceptance line
  `import python.wasocket.protocol` therefore only "imports cleanly" when
  `websockets` is installed. protocol.py alone has zero such deps (verified by
  direct file load). Out of Step 23's scope; flagged for awareness only.

## (4) Must-NOT-do / isolation / contract notes

- No `request_id` generation present (no uuid/time/counter). COMPLIANT.
- No sockets / `websockets` / `asyncio` imports. COMPLIANT.
- No divergence from `migration/node/protocol/types.ts` / CONTRACT §6 field names;
  all 23 dataclasses present with identical fields, defaults, and Optional shapes.
  COMPLIANT.
- Does NOT import/define `bridge.history.WhatsAppMessage`; correctly notes the
  SDK's WhatsAppMessage lives in `events.py` (Step 24). COMPLIANT.
- No per-tenant mutable shared state — module is pure (frozen dataclasses +
  stateless encode/decode + immutable registry tables). No isolation leak.
- `incoming_message` and `send_ack` are intentionally absent from the frame table;
  `decode` returns `(type, raw_dict)` for them so `socket.py` can still route —
  matches spec ("unknown types return `(type, raw_dict)`"). Correct.
- Files to modify / delete: None — confirmed nothing else touched for this step.
