---
sidebar_position: 6
---

# Contributing Guide

Guide for contributing to the WazzapAgents project.

## Workflow

1. Fork the repository.
2. Create a new branch from `main`.
3. Make your changes.
4. Run tests.
5. Create a Pull Request.

## Code Conventions

### JavaScript (Node.js Gateway)

- ESM modules (`import`/`export`, not `require`).
- 2-space indentation, single quotes, no trailing commas.
- Async/await for all asynchronous operations.
- Use `logger` from `src/logger.ts` for logging.
- No formatter/linter configured — match existing style and keep diffs minimal.

### Python (Bridge)

- Python 3.10+ with `from __future__ import annotations` in every file.
- Type hints used consistently.
- Dataclasses for data structures.
- Relative imports within the `python/bridge/` package.

### General

- Paths are tenant-scoped and must be canonicalized/allowlisted before runtime
  state is created. Never let one account resolve another tenant's files.
- Use `senderRef` for user references, **never** raw JIDs in LLM-facing code.
- `contextMsgId` is a 6-digit per-chat counter.

## Commit Messages

- Use imperative mood with a short prefix:
  - `add` — new feature
  - `fix` — bug fix
  - `refactor` — refactoring without behavior change
  - `docs` — documentation changes
  - `test` — adding or modifying tests
- If changing the WebSocket protocol, prefix with `protocol:`.

Examples:
```
add support for voice message transcription
fix senderRef collision on large groups
protocol: add bulk_delete command type
docs: update WebSocket protocol reference
```

## Pull Requests

PRs should include:

1. **Summary** — What changed and why.
2. **Testing** — How the changes were tested.
3. **Protocol changes** — If there are WebSocket protocol changes, document the schema changes.

## Tests

### Running Tests

```bash
# All Python tests
PYTHONPATH=python python -m pytest python/tests -q

# Node.js gateway tests (Node's built-in test runner)
pnpm test
```

### Writing Tests

- Python tests live in `python/tests/`.
- Use `pytest`.
- The gateway uses **Node's built-in test runner**: `pnpm test` runs `node --test --import tsx 'tests/**/*.test.ts'`. Add new tests under `tests/` as `*.test.ts` files (`tests/node/` for unit, `tests/e2e/` for end-to-end).

## Security

### Never Commit

- `<folder_path>/auth/` (for example `data/auth/` or `tenants/acme/auth/`) — WhatsApp sessions
- `accounts.json` — managed account catalog with per-tenant WebSocket credentials
- `.env` — Environment variables with secrets
- API keys in any form

### Security Rules

- `LLM_WS_TOKEN`, per-tenant `ws_token`, `CONTROL_PANEL_TOKEN`,
  `DIRECT_INVOKE_API_KEY`, Sub-Agent tokens, LLM API keys, and Baileys auth are
  **secrets**.
- Respect media size limits to avoid OOM.
- Moderation actions (`DELETE`/`MUTE`/`KICK`) must go through permission level gating (set via `/permission`).
- Real JIDs must never be exposed to the LLM.

## Documentation

The documentation website uses Docusaurus and is auto-deployed via GitHub Actions. The site is **English-only**.

### Local Development

```bash
cd website
npm ci
npm start
```

### Adding New Pages

1. Create a `.md` file in `website/docs/` (English).
2. Add an entry in `website/sidebars.ts`.

## CI/CD

- GitHub Actions workflow at `.github/workflows/deploy-docs.yml` deploys the website to GitHub Pages on push to `main`/`master` that modifies `website/`.
- No CI for tests or linting is currently configured.
