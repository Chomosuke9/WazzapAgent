# Step 07 — TypeScript: `messageParser`, `participants`, `mediaHandler`, `groupContext`

## Context
These four parsing/media/group modules depend only on `logger`/`config`/`caches`
(already typed) and Baileys. Converting them next keeps the leaf-first order so
that `wa/` consumers can be typed against them later.

## Contract references
- `mediaHandler` produces the `attachments[]` entries that appear in CONTRACT.md
  §7 (`Attachment` / `WhatsAppMessage.attachments`). No shape change here.

## Files to read before starting
- Original - `migration/node/messageParser.js`
- `migration/node/participants.js`
- `migration/node/mediaHandler.js`
- `migration/node/groupContext.js`

## Files to create
None beyond renames.

## Files to modify
### `migration/node/messageParser.js` → `migration/node/messageParser.ts`
**Change:** Type `unwrapMessage`, `extractText`, `extractQuoted`,
`extractMentionedJids`, `extractLocationData`, `formatLocationText`. Logic
unchanged.

### `migration/node/participants.js` → `migration/node/participants.ts`
**Change:** Type role flags (`roleFlagsForJid` → `{ isAdmin, isSuperAdmin }`),
`compactParticipantJids`, name lookups, `isOwnerJid`.

### `migration/node/mediaHandler.js` → `migration/node/mediaHandler.ts`
**Change:** Type `saveMedia` (returns an `Attachment`-shaped object per
CONTRACT.md §1 `Attachment`), `resolveAllowedAttachmentPath`,
`detectMimeFromFile`, `normalizeMime`, `inferExtension`.

### `migration/node/groupContext.js` → `migration/node/groupContext.ts`
**Change:** Type the group metadata cache shape and `getGroupContext`,
`getCachedGroupMetadata`, `parseGroupJoinStub`, `setSockAccessor`.

## Files to delete
- The four `.js` originals.

## Acceptance criteria
- `pnpm typecheck` passes with zero errors.
- `pnpm dev` boots; sending an image inbound still downloads to `media/` (no
  runtime error from `saveMedia`).
- `node --test 'tests/node/**/*.test.mjs'` passes.

## Must NOT do
- Do not change media size limits, path-sandbox logic, or group TTLs.
- Do not change `setSockAccessor`'s single-socket contract (that changes in
  Step 16/17).
- Do not convert any other file.

## Depends on
Step 06.
