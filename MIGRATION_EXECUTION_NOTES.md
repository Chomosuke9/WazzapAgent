# Migration Execution Model

**All work happens in `/migration` directory.** The original `src/`, `python/bridge/`, etc., remain untouched as reference.

## Directory layout during migration

```
/home/chomosuke/Project/wazzapagent/
├── src/                      (ORIGINAL — read-only reference)
├── python/bridge/            (ORIGINAL — read-only reference)
├── ...
├── migration/                (NEW — working directory)
│   ├── node/                 (mirrored from src/ as converted)
│   ├── python/               (mirrored from python/ as converted)
│   └── shared/               (CONTRACT.md, etc., if needed)
```

## Each step's role

- **Read from:** original `src/`, `python/bridge/`, etc. (reference only; never modify).
- **Create/modify:** `/migration/node/`, `/migration/python/` (the working copies).
- **Acceptance test:** test behavior of `/migration/` code, not the original.

## After all 34 steps

The `/migration` directory contains the fully converted, multi-account, reversed-WS codebase.
The original remains untouched. Then, a final "cutover" step (outside this plan) moves
`/migration/node` → `src`, `/migration/python` → `python/bridge`, etc.

## Why this approach

- **Safety:** no loss of original code during experimentation or rollback.
- **Reference:** old code available for consultation during conversion.
- **Atomicity:** each step's changes are isolated in the migration workspace.
- **Review:** the entire `/migration` can be reviewed before cutover.
