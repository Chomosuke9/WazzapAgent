# LLM Architecture Docs (WazzapAgents)

Architecture documentation for **LLM / agent developers** who need to understand the runtime flow, module responsibilities, and data contracts.

> **Start with [AGENTS.md](../../AGENTS.md)** for full project context, terminology, architecture decisions (ADRs), and development conventions.
> These docs go deeper into specific subsystems — they assume you've read AGENTS.md first.

## Reading order

1. `00-overview.md` — End-to-end system architecture: WhatsApp → Node.js gateway → WebSocket → Python bridge → LLM pipeline
2. `01-runtime-flow.md` — Per-event-type runtime flow: inbound messages, slash commands, sub-agent callbacks, idle triggers
3. `02-modules-map.md` — Module map with file-by-file responsibilities for both Node and Python codebases
4. `03-commands-and-permissions.md` — Slash commands, activation gate, role/permission model, mute enforcement
5. `04-protocol-and-actions.md` — WebSocket contract: message types, action dispatch, action_ack lifecycle, send modes
6. `05-state-data-and-db.md` — State management, caching (group info, participants, quiz IDs), and SQLite storage

## Key principles

- **Two WS send modes**: `send()` for best-effort transient events (incoming messages); `sendReliable()` with a reconnect queue for critical state-sync events (model changes, history invalidation, settings updates).
- **Three SQLite databases** (settings.db, stats.db, moderation.db) — each in WAL mode, kept separate to avoid locking contention between Node and Python.
- **LLM1/LLM2 pipeline**: LLM1 (router) decides whether to respond; LLM2 (responder) generates replies and tool calls. LLM1 is skipped in private chats and prefix mode.
- **Sub-agent system**: external service for complex multi-step tasks, called via `execute_subtask` tool. Uses a persistent webhook server for async callbacks and supports correction re-dispatch and steering.
- **Idle trigger**: probabilistic re-engagement — when messages since last bot reply reach a per-chat configurable range, the bot jumps in with probability `1/(max - count + 1)`.
- **Quiz system**: interactive multiple-choice buttons via NativeFlow; taps forwarded as plain text, tracked in a bounded `quizMessageIds` set for correct routing.