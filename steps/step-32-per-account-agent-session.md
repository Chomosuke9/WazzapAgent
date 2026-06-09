# Step 32 — Per-account `AgentSession` (Python state isolation)

## Context
The agent's per-chat state (`per_chat` history, `per_chat_lock`,
`pending_by_chat`, `media_paths_by_chat`, the sub-agent tracker, reply-dedup
signatures, idle counters, pending-ack maps) is currently created once inside
`handle_socket`. To run N accounts in one process, this state must be isolated
**per `WaSocket`**. Extract it into an `AgentSession` so each account has its own.

## Contract references
- **CONTRACT.md §4** — an `AgentSession` is constructed around one `WaSocket` and
  registers its handlers via `sock.on(...)`.
- **CONTRACT.md §7** — handlers consume `WhatsAppMessage`.

## Files to read before starting
- `python/bridge/main.py` — the `handle_socket` local-state block and the
  `process_message_batch` / `flush_pending` closures + the Step 28/29 handlers
- `python/wasocket/socket.py` (Step 27)

## Files to create
### `python/bridge/session.py` (or an `AgentSession` class inside `main.py`)
**Purpose:** Encapsulate all per-account agent state and handler registration.
**Exports:** `class AgentSession` with `__init__(self, sock: WaSocket)` and a
`register(self) -> None` that wires `@sock.on("message")`, `"status"`,
`"action_ack"`, and the control-event handlers (the bodies from Steps 28/29).
**Must NOT contain:** any global module-level per-chat state; any second
`WaSocket`; any cross-account shared mutable dict.
**Key logic:** every field that was a `handle_socket` local becomes an instance
attribute; the closures (`process_message_batch`, `flush_pending`,
`_deliver_subagent_result`, etc.) become methods or closures bound to `self`.
The global `subagent_tracker`/`subagent_webhook` singletons must be reviewed:
either keep one webhook server shared across sessions keyed by `chat_id`
(chat_ids are namespaced per account by `folder_path` at the DB layer), or one
tracker per session — choose per-session trackers to preserve isolation.

## Files to modify
### `python/bridge/main.py`
**Change:** Replace the single inline `handle_socket` state with
`AgentSession(sock).register()`. `main()` still constructs one socket here
(N-socket boot is Step 33).
**Location:** `handle_socket` → `AgentSession`; `main()` wiring.

## Files to delete
None.

## Acceptance criteria
- `pytest python/tests/test_agent_session.py`:
  - constructing two `AgentSession`s (over two stub `WaSocket`s) yields
    independent `per_chat` history — a `WhatsAppMessage` delivered to session A's
    `"message"` handler never appears in session B's history.
  - independent idle counters / dedup signatures / pending-ack maps.
- `python -m python.bridge.main` (single account) still works end-to-end as after
  Step 28/29.

## Must NOT do
- Do not add the multi-account boot loop here (Step 33).
- Do not change the agent's batching/LLM/sub-agent logic — only relocate state.
- Do not reintroduce module-global per-chat dicts.

## Depends on
Step 28, Step 29.
