# Step 12 — TypeScript: `wa/` consumers (`actions`, `moderation`, `presence`, `runCommand`, `outbound`, `events`, `inbound`)

## Context
Convert the action/event modules that produce outbound WhatsApp sends and the
inbound→`incoming_message` normalizer. Type-only: keep the existing
`wsClient.send` usage (direction flip and `folderPath` stamping are Phase 3).
Type `sendOutgoing`'s return against the protocol types.

## Contract references
- `sendOutgoing` return → CONTRACT.md §5 `ActionResult.send_message`
  (`{ sent: SentEntry[], replyTo }`).
- `inbound` builds `WhatsAppMessagePayload` (CONTRACT.md §7) — **without**
  `folderPath` yet (added in Step 18).

## Files to read before starting
- Original - `migration/node/wa/{actions.js,moderation.js,presence.js,runCommand.js,outbound.js,events.js,inbound.js}`
- `migration/node/protocol/types.ts` (Step 09)

## Files to create
None beyond renames.

## Files to modify
### `migration/node/wa/actions.js` → `actions.ts`
**Change:** Type `reactToMessage`, `deleteMessageByContextId`, and the
`actionError(code, detail)` helper (its `code` is a CONTRACT.md §2 `ErrorCode`).

### `migration/node/wa/moderation.js` → `moderation.ts`
**Change:** Type `kickMembers` → `ActionResult.kick_member` shape.

### `migration/node/wa/presence.js` → `presence.ts`
**Change:** Type `markChatRead`, `sendPresence`.

### `migration/node/wa/runCommand.js` → `runCommand.ts`
**Change:** Type `dispatchRunCommand` → `{ ok, detail, command }`.

### `migration/node/wa/outbound.js` → `outbound.ts`
**Change:** Type `sendOutgoing` (return `{ sent: SentEntry[]; replyTo: string | null }`),
`renderOutboundMentions`, `sendLottieSticker`.

### `migration/node/wa/events.js` → `events.ts`
**Change:** Type the three emitters; keep `wsClient.send({ type:'incoming_message', payload })`.

### `migration/node/wa/inbound.js` → `inbound.ts`
**Change:** Type `handleIncomingMessage`/`handleGroupParticipantsUpdate`; annotate
the `payload` literal as `WhatsAppMessagePayload` (omitting `folderPath` for now).

## Files to delete
- The seven `.js` originals.

## Acceptance criteria
- `pnpm typecheck` passes with zero errors.
- `pnpm dev` round-trips: an inbound message reaches Python (existing server) and
  a `send_message` action sends to WhatsApp without type/runtime error.
- `node --test 'tests/node/**/*.test.mjs'` passes.

## Must NOT do
- Do not stamp `folderPath` onto payloads (Step 18).
- Do not replace `wsClient.send`/`sendReliable` with a registry call (Steps 18/21).
- Do not change mention-rendering or media-send logic.

## Depends on
Step 07, Step 10, Step 11.
