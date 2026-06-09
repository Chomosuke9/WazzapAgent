# Step 18 — `eventForwarder.ts`

## Context
Move the Baileys→Python event path off the global `wsClient` and onto the
registry, stamping `folderPath` onto every event so the right Python client (and
later the right `WaSocket`) receives it. Also normalize `whatsapp_status` to the
contract's `WaStatus`.

## Contract references
- **CONTRACT.md §1.4** — `incoming_message`, `whatsapp_status`.
- **CONTRACT.md §7** — `WhatsAppMessagePayload.folderPath` becomes **always
  present** (this step adds it).
- **CONTRACT.md §1.1** — `WaStatus` normalization (`closed→close`).

## Files to read before starting
- Original - `migration/node/wa/inbound.ts` (the `wsClient.send({ type:'incoming_message', payload })`)
- `migration/node/wa/events.ts` (the three `wsClient.send` emitters)
- `migration/node/wa/connection.ts` Listener 2 + `connection.update`
- `migration/node/account/accountContext.ts`, `migration/node/server/accountRegistry.ts`

## Files to create
### `migration/node/account/eventForwarder.ts`
**Purpose:** Turn Baileys events for one account into `OutboundFrame`s and send
them to that account's client via the registry.
**Exports:**
- `forwardIncoming(entry: AccountEntry, payload: WhatsAppMessagePayload): void`
- `forwardStatus(entry: AccountEntry, status: WaStatus, reason?: number): void`
- (a factory that binds an `AccountEntry` for use as the `messages.upsert`/
  `connection.update` callback installed by `baileysFactory`).
**Must NOT contain:** action handling (Step 19), control-event emission
(Step 21), the WS server (Step 20).
**Key logic:** stamp `payload.folderPath = entry.folderPath`; `incoming_message`
via `registry.sendToClient` (best-effort); `whatsapp_status` via
`registry.sendReliableToClient` (reliable) using the normalized `WaStatus`.

## Files to modify
### `migration/node/wa/inbound.ts`
**Change:** Replace the direct `wsClient.send(...)` with a call through the
injected forwarder/`AccountEntry`; add `folderPath` to the built payload.
**Location:** `handleIncomingMessage` near the `wsClient.send` call.

### `migration/node/wa/events.ts`
**Change:** Route the three synthetic emitters
(`emitGroupJoinContextEvent`/`emitBotActionContextEvent`/`emitBotRoleChangeEvent`)
through the forwarder with `folderPath` stamped.
**Location:** each `wsClient.send` call site.

## Files to delete
None.

## Acceptance criteria
- `pnpm typecheck` passes with zero errors.
- `tests/node/event-forwarder.test.ts`: a fake upsert for account A is delivered
  **only** to A's bound client and the payload includes `folderPath === A`;
  a `connection.update` `close` is forwarded as `whatsapp_status` with
  `status: "close"` (not `"closed"`).
- A status event sent while A's client is unbound is queued (reliable) and
  delivered after bind.
- `node --test` green.

## Must NOT do
- Do not change `incoming_message` field semantics other than adding `folderPath`.
- Do not route actions or control events here.
- Do not flip the boot path.

## Depends on
Step 16, Step 17.
