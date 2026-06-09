# Migration Execution Guide

**All 34 migration steps now execute in the `/migration` directory, leaving the original code untouched.**

## Directory Structure

```
/home/chomosuke/Project/wazzapagent/
├── src/                          (ORIGINAL — untouched reference)
├── python/bridge/                (ORIGINAL — untouched reference)
├── python/wasocket/              (ORIGINAL — not yet created)
├── package.json, tsconfig.json   (ORIGINAL — shared by project)
│
├── migration/                    (NEW WORKING AREA)
│   ├── node/                     (Node/TypeScript conversion)
│   │   ├── index.ts              (from src/index.js)
│   │   ├── logger.ts             (from src/logger.js → step 05)
│   │   ├── config.ts             (from src/config.js → step 05)
│   │   ├── protocol/
│   │   │   └── types.ts          (new → step 09, implements CONTRACT.md §5)
│   │   ├── wa/                   (all wa/* files → steps 10–13)
│   │   ├── server/               (new folder)
│   │   │   ├── wsServer.ts       (new → step 20)
│   │   │   └── accountRegistry.ts (new → step 15)
│   │   └── account/              (new folder)
│   │       ├── accountContext.ts (new → step 16, D2 atomic)
│   │       ├── baileysFactory.ts (new → step 17, per-tenant db/ layout)
│   │       ├── eventForwarder.ts (new → step 18, normalizes WaStatus)
│   │       └── actionDispatcher.ts (new → step 19)
│   │
│   └── python/                   (Python SDK + bridge conversion)
│       └── bridge/               (main.py, db.py, etc. with per-tenant DBs)
│           └── ...
│       └── wasocket/             (new Python SDK → steps 22–27)
│           ├── errors.py         (step 22)
│           ├── protocol.py       (step 23)
│           ├── events.py         (step 24)
│           ├── correlation.py    (step 25)
│           ├── transport.py      (step 26)
│           ├── socket.py         (step 27)
│           └── __init__.py
```

## Execution Flow

1. **Steps 01–04** (Phase 0–1): Cleanup + TS toolchain setup
   - `migration/python/bridge/commands.py` deleted
   - `migration/node/tsconfig.json` created
   - `migration/node/*.js` reads from `src/` reference

2. **Steps 05–14** (Phase 2): JS → TS conversion (leaf-first)
   - Copy files from `src/` to `migration/node/`, convert to `.ts`
   - Example: `src/logger.js` → `migration/node/logger.ts`
   - **Original `src/` remains untouched**

3. **Steps 15–21** (Phase 3): Multi-account + WS server
   - Create `migration/node/server/` and `migration/node/account/` folders
   - **Live boot still uses old path** (Step 28 flips it)

4. **Steps 22–27** (Phase 4): Python SDK
   - Create `migration/python/wasocket/` (new package)
   - Tested against Step 20's wsServer or stub

5. **Steps 28–31** (Phase 5): Topology reversal (ATOMIC)
   - Step 28 flips Node boot from client → server, Python main → WaSocket client
   - Step 28 includes **Behaviors that break**, **Rollback**, **Verification** sections
   - Steps 29–31 are subsequent cleanup steps

6. **Steps 32–34** (Phase 6): Multi-account finalization
   - Step 32: Per-account `AgentSession` (Python state isolation per WaSocket)
   - Step 33: Multi-account entrypoint + per-tenant DB wiring
   - Step 34: Docs, env, e2e test

## Working with Migration Files

### Reading original code (reference)
```bash
# All "Files to read before starting" point to original code:
cat src/logger.js          # original
cat python/bridge/main.py  # original
```

### Creating/modifying migration files
```bash
# Step 05 creates migration/node/logger.ts from src/logger.js reference:
cp src/logger.js migration/node/logger.js
# Then convert to .ts in migration/
```

### Testing
Each step's acceptance criteria test `migration/` code:
```bash
# Example: Step 05 typecheck
pnpm typecheck

# Example: Step 20 ws-server test against migration/node/
node --test tests/node/ws-server.test.ts
```

## Before "Cutover" (Post-Step 34)

The entire `/migration` directory is a fully-functional, multi-account, reversed-WS codebase. To cutover:

```bash
# After all 34 steps are complete and tested:
rm -rf src python/bridge python/wasocket
mv migration/node src
mv migration/python/bridge python/bridge
mv migration/python/wasocket python/wasocket
rmdir migration/python migration

# Then: restart from src/, python/ (which are now the migrated versions)
```

## Why This Approach

- **Safety:** Original code never touched; full rollback available anytime.
- **Reference:** Developers can compare old vs. new during conversion.
- **Atomic:** Each step's changes isolated in `/migration/`.
- **Reversible:** If a step introduces a bug, fix it in `/migration/` without affecting production or reference code.
- **Review:** The entire `/migration` can be reviewed en-mass before cutover.

## Key Files Already Updated

- **CONTRACT.md** (project root): Single source of truth for all wire shapes, types, and interfaces.
- **MIGRATION_EXECUTION_NOTES.md**: Overview of the execution model.
- **All 34 step files** (`steps/step-NN-*.md`): Updated to reference `migration/` paths throughout.

## Next Steps

1. Follow each step sequentially, creating/modifying files in `/migration/`.
2. Verify each step's acceptance criteria passes.
3. After Step 34 completes, review the entire `/migration/` directory.
4. Once approved, execute the cutover (move `/migration/` content into production paths).
