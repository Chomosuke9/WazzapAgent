# Step 14 — Centralize configuration
**Phase:** 4 · **Risk:** med · **Depends on:** step-13

## Goal
Make `config.ts` (Node) and `config.py` (Python) the single source of truth for
configuration. Logic modules consume typed config objects instead of reading
env vars directly.

## Why (audit — Medium #8)
136 env reads are scattered across 25 files; logic modules bypass the config
modules; defaults are defined twice across the two languages with no shared
schema. Only `.env.example` (62 vars) is the de-facto contract.

## Changes
- Node: audit every `process.env` read in `src/`; move them into `config.ts`,
  exposing a typed, validated config object. Logic modules import config, not
  `process.env`. `git grep -n "process.env" src/` → only `config.ts`.
- Python: same for `os.environ`/`os.getenv` → consolidate into `config.py`
  (and `subagent/config.py` may remain a sub-config but sourced consistently).
  `git grep -n "os.environ\|os.getenv" python/bridge` → only the config
  module(s).
- Validate required transport vars (`WS_LISTEN_PORT`, `NODE_URL`) at startup
  with clear errors.
- Ensure `.env.example` lists every consumed var; note defaults centrally.

## OOP / target
Configuration is read once at the edge and injected; no scattered env reads in
business logic.

## Must NOT
- Must NOT change default values or env var names (compatibility).
- Must NOT introduce a new config file format.

## Verification
- `git grep` confirms env reads are confined to the config module(s).
- Node typecheck 0; both test suites green; `pnpm dev` + bridge boot.

## Done when
- All env access is centralized; gates green.
