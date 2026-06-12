# Step 07 — Break `account/↔wa/` cycle, type the socket, decompose god-functions
**Phase:** 2 · **Risk:** med · **Depends on:** step-06

## Goal
Establish clean one-directional layering and remove the largest untyped/oversized
functions on the Node side.

## Why (audit — Medium #7, Low #6/#10)
`account/` and `wa/` import each other, worked around with lazy/runtime imports
(`connection.ts:16–17` documents it; `baileysFactory.ts:47–65`,
`actionDispatcher.ts:43–46` import `wa/*`; `wa/events.ts:4` imports
`account/eventForwarder` at runtime). The Baileys `sock` is typed `any`
(`accountContext.ts:54`, `parseCommand.ts:150`) with dozens of unchecked
`sock.sendMessage` sites and `as unknown as` at wire boundaries. God-functions:
`baileysFactory.buildSocket` (~334 lines), `connection.handleButtonResponse`
(~287), `actionDispatcher.routeAction` (273-line 12-branch dispatch).

## Changes
- **Layering:** define the interfaces that `wa/` needs from `account/` (and vice
  versa) in `protocol/ports.ts`; depend on the interface, not the concrete
  module. Remove the lazy/runtime `import()` workarounds. Target dependency
  direction: `protocol → account → wa` (or a clean ports seam), no cycles.
- **Socket type:** introduce a `WaSocketLike` interface (the subset of Baileys
  used) and replace `sock: any` at the public seams; remove `as unknown as` at
  `wa/events.ts:174/231/286` and `wa/inbound.ts:368/373` by using
  `protocol/types`.
- **Decompose:** `buildSocket` → factory + separate listener-wiring units;
  `handleButtonResponse` → per-reply-type handlers (quiz/list/settings/modelcfg);
  `routeAction` → a dispatch map of per-action handler functions/classes
  (mirrors the command registry idea).

## OOP / target
No import cycles; the socket is typed at every boundary; each former god-function
is a small composition of single-purpose units.

## Must NOT
- Must NOT change dispatch behavior or wire semantics.
- Must NOT over-type Baileys (only the used surface in `WaSocketLike`).

## Verification
- Node typecheck 0; `node --test` no new failures; `pnpm dev` boots.
- No lazy `import()` cycle workarounds remain (`git grep -n "await import" src/account src/wa`
  reviewed; only legitimate dynamic imports remain).

## Done when
- Cycle removed, socket typed, three god-functions decomposed; gates green.
