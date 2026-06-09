# Step 09 — `src/protocol/types.ts` (TypeScript wire types)

## Context
Create the single TypeScript module that exports every WS frame type plus
`AccountEntry` and `BaileysFactoryOptions`. This is the Node-side realization of
CONTRACT.md §5 and becomes the type source consumed by `wa/*`, `eventForwarder`,
`actionDispatcher`, and `wsServer`. Types only — emits nothing at runtime.

## Contract references
- **CONTRACT.md §5** (TypeScript Types) — implements it verbatim.
- **CONTRACT.md §1** (WS Protocol) — frame shapes.
- **CONTRACT.md §2** (`ErrorCode`).
- **CONTRACT.md §7** (`WhatsAppMessagePayload`).

## Files to create
### `src/protocol/types.ts`
**Purpose:** Exported TypeScript types for all WS frames + registry/factory types.
**Exports:** exactly the names listed in CONTRACT.md §5 — `WaStatus`,
`ErrorCode`, `Attachment`, `HelloPayload`, every `*Payload` action type,
`InboundActionFrame`, `InboundFrame`, `HelloAckPayload`, `SentEntry`,
`ActionResult`, `ActionAckPayload`, `SendAckPayload`, `WsErrorPayload`,
`WhatsAppStatusPayload`, `OutboundFrame`, `WhatsAppMessagePayload`,
`AccountEntry`, `BaileysFactoryOptions`.
**Must NOT contain:** any runtime code, value exports, validation logic, or
re-definition of types already imported from `baileys`/`ws` (reference them via
`import("baileys").WASocket` etc. as in CONTRACT.md §5).
**Key logic:** `WhatsAppMessagePayload` matches CONTRACT.md §7 field-by-field
(mark optional fields with `?`). `AccountEntry.ctx: AccountContext` references a
type that does not exist yet — declare it as an opaque
`export interface AccountContext { /* defined in Step 16 */ }` placeholder here
so the file compiles, and let Step 16 flesh it out.

## Files to modify
None.

## Files to delete
None.

## Acceptance criteria
- `pnpm typecheck` passes with zero errors.
- `node -e "require('fs').accessSync('src/protocol/types.ts')"` succeeds.
- A `tests/node/protocol-types.test.ts` that constructs one literal of each
  `*Payload` type and assigns it to the union compiles (type-level check).
- Importing `OutboundFrame`/`InboundFrame` from another `.ts` file resolves.

## Must NOT do
- Do not import this from any production module yet (later steps do that).
- Do not add encode/decode functions (that is Python `protocol.py`, Step 23;
  Node validates structurally, not via a serializer here).
- Do not define `AccountContext`'s real fields (Step 16).

## Depends on
Step 05.
