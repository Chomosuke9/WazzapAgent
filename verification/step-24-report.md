# Step 24 Verification Report — `wasocket/events.py`

## 1. Verdict: ACCURATE

The implemented `migration/python/wasocket/events.py` fully satisfies the Step 24
spec and CONTRACT.md §7/§4/§1.5. All event-name constants, the frozen
`WhatsAppMessage` dataclass (exactly the §7 fields + `raw`), and
`from_payload` are present and correct. The accompanying test file
`migration/python/tests/test_events.py` exercises every acceptance criterion.

## 2. Acceptance-criteria checklist

| Criterion | Result |
|-----------|--------|
| `events.py` exists with all 12 event-name constants (MESSAGE, STATUS, READY, ERROR, ACTION_ACK, SEND_ACK, + 6 control events) and exact wire string values | PASS |
| `@dataclass(frozen=True) class WhatsAppMessage` with EXACTLY the §7 fields (snake_case); required Always fields w/o defaults; optionals default `None` | PASS (20 Always + 14 Optional = 34 §7 fields + `raw`) |
| `from_payload(payload) -> WhatsAppMessage` camelCase→snake_case builder | PASS |
| `raw: dict` field preserving original payload | PASS |
| `folderPath` always present; optionals map to `None`; `from_payload` does not raise on missing optional | PASS (loop falls back to `None`, `[]` for attachments) |
| Test: full §7 payload parses with every field populated and `folder_path` set | PASS (`test_full_payload_every_field_populated`) |
| Test: minimal (Always-only) payload parses, optionals are `None` | PASS (`test_minimal_payload_optionals_are_none`) |
| Test: `msg.raw == input payload` | PASS (`test_raw_preserves_input_payload`) |
| `import python.wasocket.events` imports cleanly | PASS for events.py itself (verified in isolation); see Note 1 re: package `__init__` |

### Detailed field cross-check vs CONTRACT.md §7
All 34 §7 fields present with correct presence classification:
- Always (required, no default): folder_path, instance_id, chat_id, chat_name,
  chat_type, message_id, sender_id, sender_ref, sender_name, sender_is_admin,
  sender_is_super_admin, is_group, bot_is_admin, bot_is_super_admin, from_me,
  context_only, trigger_llm1, timestamp_ms, message_type, attachments (20).
- Optional (default None): context_msg_id, sender_is_owner, text, quoted,
  mentioned_jids, mentioned_participants, bot_mentioned, replied_to_bot,
  location, group_description, slash_command, command_handled, group_event,
  action_log (14).

Verified `snake_to_camel` round-trips all tricky names correctly:
`trigger_llm1→triggerLlm1`, `timestamp_ms→timestampMs`,
`context_msg_id→contextMsgId`, `sender_is_super_admin→senderIsSuperAdmin`,
`group_event→groupEvent`, `action_log→actionLog`, `mentioned_jids→mentionedJids`.
Confirmed by isolated execution (35 dataclass fields total = 34 + raw).

## 3. Issues list

None of BLOCKER/MAJOR severity.

- [MINOR] migration/python/wasocket/events.py — `camel_to_snake` is exported but
  unused by `from_payload` (which only uses `snake_to_camel`). Harmless helper /
  mild dead code; matches the documented intent of mirroring
  `wasocket.protocol`. No correctness impact.

## 4. Must-NOT-do / isolation / contract notes

- Does NOT import or subclass `bridge.history.WhatsAppMessage` — confirmed via
  grep (only a prose comment references it). PASS.
- No event-dispatch / `on()` logic present (deferred to Step 27). PASS.
- No transport/asyncio/websockets/socket imports — only `re`, `dataclasses`,
  `typing`. PASS.
- Per-account isolation: model is a frozen, immutable value object built per
  payload; `raw` references the caller-supplied dict (no shared mutable module
  state). `folder_path` is preserved as the routing key per §7. No leak concern.

### Note 1 — `import python.wasocket.events` in this environment
Importing the submodule triggers `wasocket/__init__.py` (authored in Step 27),
which transitively imports `socket.py → transport.py → websockets`. With
`websockets` not installed in the verification sandbox, that chain raises
`ModuleNotFoundError`. This is an environment dependency / Step 27 concern, NOT
a defect of Step 24's `events.py`: loading `events.py` in isolation succeeds
cleanly (verified), since it has zero third-party imports. In a normally
provisioned environment (`pip install -r requirements.txt`) the criterion holds.
