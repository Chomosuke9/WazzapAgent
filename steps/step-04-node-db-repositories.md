# Step 04 — Split `db.ts` domain accessors into repository classes
**Phase:** 1 · **Risk:** med · **Depends on:** step-03

## Goal
Turn the per-domain free functions in `db.ts` into repository classes, each
taking a `Database` via its constructor. This isolates SQL by domain and makes
per-account injection (step-05) trivial.

## Why (audit)
`db.ts` mixes settings (~1246–1355), stats (~1357–1397), models (~1399–1569),
owner-contact, subagent, global settings, idle, announcement, and activation
(~1727–1956) in one file. Splitting per domain improves navigability and is the
precondition for instance-based ownership.

## Changes
- New `src/db/repositories/`:
  - `SettingsRepository` (chat settings, mode/prompt/permission/trigger/idle)
  - `StatsRepository` (dashboard stats buffer/flush)
  - `ModelRepository` (per-chat + default model config)
  - `ModerationRepository` (mutes)
  - `ActivationRepository` (activation codes/state)
  - `SubagentRepository` (subagent enable + stored data)
  - plus any remaining domains (owner-contact, announcement, global settings) —
    group sensibly; do not create one-method classes gratuitously.
- Each repository: constructor `(db: Database)`; methods are the moved
  functions, verbatim SQL.
- Keep the temporary process-wide `Database` shim from step-03 so the existing
  exported functions still resolve (delegate them to singleton repo instances).
  Callers remain untouched until step-05 threads per-account repos.

## OOP / target
One repository = one domain = one cohesive SQL surface, depending only on
`Database`. No cross-repository calls; no module globals inside repos.

## Must NOT
- Must NOT change SQL or method behavior.
- Must NOT yet rewire callers to per-account repos (step-05).

## Verification
- Node typecheck 0; `node --test` no new failures; `pnpm dev` boots.

## Done when
- Every domain accessor lives in a repository class under
  `src/db/repositories/`; gates green via the shim.
