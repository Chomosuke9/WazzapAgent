# Step 15 — `accountRegistry.ts`

## Context
The multi-account server needs a single place that maps each `folderPath` to its
live state: the Baileys socket, the bound Python client (if any), the per-account
state context, the normalized WhatsApp status, and a per-account reliable-event
queue. This leaf module is built first; nothing wires into the live boot yet.

## Contract references
- **CONTRACT.md §5** — `AccountEntry`, `OutboundFrame`, `WaStatus`.
- **CONTRACT.md §1.6** — reliable vs best-effort (the reliable queue holds the
  reliable Node→Python frames: `whatsapp_status`, control events, `hello_ack`).

## Files to read before starting
- Original - `migration/node/protocol/types.ts` (Step 09 — `AccountEntry`, `OutboundFrame`)
- `migration/node/wsClient.ts` (the `reliableQueue`/`MAX_RELIABLE_QUEUE` pattern to mirror)

## Files to create
### `migration/node/server/accountRegistry.ts`
**Purpose:** In-memory `Map<folderPath, AccountEntry>` + per-account send helpers.
**Exports:**
- `getOrCreate(folderPath: string): AccountEntry`
- `get(folderPath: string): AccountEntry | undefined`
- `bindClient(folderPath, client: WebSocket): void`
- `unbindClient(folderPath): void`
- `bindSock(folderPath, sock): void`
- `list(): AccountEntry[]`
- `remove(folderPath): void`
- `sendToClient(folderPath, frame: OutboundFrame): void`  // best-effort
- `sendReliableToClient(folderPath, frame: OutboundFrame): void`  // queue if no client
- `flushReliableQueue(folderPath): void`
- `MAX_RELIABLE_QUEUE = 1000`
**Must NOT contain:** any Baileys socket creation (Step 17), any WS server
listener (Step 20), any action dispatch (Step 19), any `AccountContext` field
definitions beyond storing the object (Step 16 owns that type).
**Key logic:** `sendReliableToClient` sends immediately if a client is bound and
OPEN, else pushes onto `reliableQueue` (drop oldest past `MAX_RELIABLE_QUEUE`,
same bound as `LLMWebSocket.MAX_RELIABLE_QUEUE`). `flushReliableQueue` drains in
order on (re)bind. `sendToClient` drops if no OPEN client (best-effort).

## Files to modify
None.

## Files to delete
None.

## Acceptance criteria
- `pnpm typecheck` passes with zero errors.
- `tests/node/account-registry.test.ts`:
  - `getOrCreate` is idempotent (same object for same folderPath).
  - `sendReliableToClient` with no bound client enqueues; after `bindClient` +
    `flushReliableQueue` the frames are delivered in order.
  - pushing > 1000 reliable frames drops the oldest (length stays ≤ 1000).
  - `sendToClient` with no client is a no-op (does not throw, does not enqueue).
- `node --test` green.

## Must NOT do
- Do not import or start `ws.Server` here.
- Do not create Baileys sockets or touch `connection.ts`.
- Do not wire this into `index.ts` boot.

## Depends on
Step 09.
