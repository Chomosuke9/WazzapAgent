# Step 15 — Docs, final foldering & structure verification
**Phase:** 4 · **Risk:** low · **Depends on:** step-14

## Goal
Land the final folder layout, update the docs to match, and verify the whole
refactor against the target architecture.

## Why (audit — Low #6, #7)
`src/` (formerly `migration/node`) has WA-domain modules
(`participants`/`groupContext`/`messageParser`/`identifiers`/`caches`) sitting
flat at the root beside infra (`config`/`logger`). `AGENTS.md`/`README.md`
describe the pre-refactor structure. One stray TODO remains (`sticker.ts:121`).

## Changes
- Move the flat WA-domain modules under `src/wa/domain/` (or a sensibly named
  domain folder); update imports. Keep infra (`config`, `logger`, `index`) at
  the root.
- Update `AGENTS.md` and `README.md` directory/architecture sections to the new
  `src/` + `python/` layout and the collaborator/repository structure. Ensure
  they do not contradict `CONTRACT.md`.
- Resolve or document the remaining TODO.
- Final structure check against `REFACTOR_PLAN.md` §3: no file over ~600 lines
  without justification; no god-functions; no module-global tenant state;
  command registry + repositories + collaborators in place.

## OOP / target
The repository matches the target architecture in `REFACTOR_PLAN.md` §3.

## Must NOT
- Must NOT change runtime behavior or protocol.
- Must NOT contradict `CONTRACT.md`.

## Verification
- Node typecheck 0; both suites green; `pnpm dev` + bridge boot end-to-end
  (scripted `WaSocket` handshake reaches `ready`).
- Optional: a two-account smoke test (two tenants, isolated DB/auth/stickers).
- Docs reviewed for accuracy.

## Done when
- Layout finalized, docs updated, structure verified against the plan; all gates
  green. Refactor complete.
