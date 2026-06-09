# Step 02 — Dead-reference audit

## Context
After deleting `commands.py` (Step 01), confirm no other module still imports it
and that no helper existed solely to serve it. This is a verification step with
at most trivial deletions; it prevents a stale import from surfacing later in the
migration.

## Contract references
- None.

## Files to read before starting
- Original - `migration/python/bridge/main.py` (imports)
- Output of a repo-wide grep (below)

## Files to create
None.

## Files to modify
- Only files surfaced by the grep as containing a now-dangling reference
  (expected: none).

## Files to delete
- Any symbol confirmed orphaned (exported only for `commands.py`). Expected: none.

## Acceptance criteria
- `grep -rn "commands" migration/python/bridge/ | grep -vi "command_handler\|run_command\|slashCommand\|commandHandled\|# \|\"\"\""`
  shows no import of the deleted module.
- `python -c "import ast,sys; [ast.parse(open(f).read()) for f in sys.argv[1:]]" $(git ls-files 'migration/python/**/*.py')`
  exits 0 (all Python files still parse).
- Node bridge smoke test (echo server) processes a `/help` and a plain text
  message without error: `pip install websockets==12.* pydantic && python examples/llm_ws_echo.py`
  alongside `python -m python.bridge.main` exchanges at least one
  `incoming_message` and one action.
- `node --test 'tests/node/**/*.test.mjs'` passes.

## Must NOT do
- Do not refactor or rename anything beyond removing a confirmed dead symbol.
- Do not begin any TypeScript work here.

## Depends on
Step 01.
