# Step 01 — Delete dead Python `commands.py`

## Context
`python/bridge/commands.py` is a legacy slash-command handler that is no longer
reachable. `main.py` imports `parse_command`/`handle_command`/`CommandResult`
**only** in its `except ImportError` fallback import branch; the primary
relative-import branch never imports it, and `process_message_batch` routes all
slash commands through Node (`commandHandled`) plus inline `/reset`, `/dump`,
`/sticker`. Removing it shrinks the surface before the migration begins.

## Contract references
- None. This step changes no wire shape, type, or interface in CONTRACT.md.

## Files to read before starting
- `python/bridge/commands.py`
- `python/bridge/main.py` (the two import branches near the top, and the
  `except ImportError:` fallback block referencing `bridge.commands`)

## Files to create
None.

## Files to modify
### `python/bridge/main.py`
**Change:** Remove the line(s) importing from `bridge.commands`
(`from bridge.commands import parse_command, handle_command, CommandResult`) in
the `except ImportError:` fallback block so the fallback branch matches the
primary branch (which never imported it).
**Location:** the top-of-file `try: … except ImportError:` import block.

## Files to delete
- `python/bridge/commands.py` — dead code; not imported on the live path.

## Acceptance criteria
- `grep -rn "bridge.commands\|import commands\|parse_command\|handle_command" python/`
  returns **zero** matches.
- `python -m python.bridge.main --help`-equivalent boot (start the process; it
  must reach "Listening for gateway" without `ImportError`/`ModuleNotFoundError`).
- The process also imports cleanly when run as `python python/bridge/main.py`
  (exercises the fallback branch).
- `git status` shows `python/bridge/commands.py` deleted and only the import
  block of `main.py` modified.

## Must NOT do
- Do not touch any other `main.py` logic (debounce, batching, action handling).
- Do not modify `commandHandler.js` or any Node command handler.
- Do not change any wire shape or add new behavior.

## Depends on
None.
