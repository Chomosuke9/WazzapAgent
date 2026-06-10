# Step 07 Verification — TS: messageParser, participants, mediaHandler, groupContext

## (1) Verdict: PARTIAL

The four target modules were correctly renamed `.js` → `.ts`, fully typed, and
their core parsing/media/group logic is preserved byte-for-byte versus the
original `src/` reference. The `.js` originals are gone and all consumers
compile against the new typed exports. **However**, the step's explicit "Must
NOT do" boundary was crossed: `setSockAccessor`'s single-socket contract was not
retained — it was removed entirely and replaced by per-account `ctx.sock`
threading (the work the step says belongs to Step 16/17). The end state is
internally consistent and correct (the whole codebase was migrated holistically
to `AccountContext`; `caches.ts` is annotated "As of Step 16"), so this is a
sequencing/scope divergence rather than a runtime bug.

## (2) Acceptance-criteria checklist

- [PASS] `messageParser.js` → `.ts`: `unwrapMessage`, `extractText`,
  `extractQuoted`, `extractMentionedJids`, `extractLocationData`,
  `formatLocationText` all typed; logic identical (lottie unwrap, location,
  interactive text, contact placeholder all preserved). Local `contextInfo`
  variable correctly renamed `ctx`→`info` to avoid shadowing the new
  `AccountContext` param. No behavior change.
- [PASS] `participants.js` → `.ts`: `roleFlagsForJid` → `ParticipantRoleFlags`,
  `compactParticipantJids`, name lookups, `isOwnerJid`, `normalizeKickTargets`
  all typed; logic preserved.
- [PASS] `mediaHandler.js` → `.ts`: `saveMedia` returns a typed `SavedAttachment`
  (documented against CONTRACT §7), `resolveAllowedAttachmentPath`,
  `detectMimeFromFile`, `normalizeMime`, `inferExtension` typed. MIME table,
  sticker→image decrypt fallback, detected-mime rename, base64 thumbnail logic
  all identical to original.
- [PASS] `groupContext.js` → `.ts`: group metadata cache shape typed via
  `GroupContextValue`/`GroupMetadataCacheEntry`; `getGroupContext`,
  `getCachedGroupMetadata`, `parseGroupJoinStub` typed; logic preserved.
- [PASS] Files to create: none beyond renames — satisfied.
- [PASS] Files to delete: the four `.js` originals are gone (`ls`/git confirm
  only `.ts` present, no pending diff).
- [PASS] Media size limits, path-sandbox logic (`isPathWithin`, realpath checks
  on media/stickers/stickers_user), and group TTLs (`GROUP_METADATA_TTL_MS`
  = 60000, `GROUP_JOIN_DEDUP_TTL_MS` = 15000) are UNCHANGED.
- [PASS] `pnpm typecheck` (static check only — not executed per the read-only
  rule): all imported symbols resolve and signatures align — `identifiers.ts`
  ctx-based `normalizeJid`/`findContextMsgIdByMessageId`/`rememberSenderRef`/
  `normalizeContextMsgId`; `utils/index.ts` `streamToFile`; `caches.ts`
  `ParticipantRoleFlags`/`GroupContextValue`/`cacheSetBounded`/TTL consts;
  baileys `proto`/`MediaType`/`WAMessage`/`WAMessageKey`/`WAMessageStubType`.
  `MediaKind` is a subset of baileys `MediaType` so `downloadMediaToFile` calls
  typecheck. Not independently run.
- [PASS] `pnpm dev` boots / inbound image downloads (static): `saveMedia` flow is
  logically identical to the original and is wired into `wa/inbound.ts`. Not run.
- [N/A→PASS] `node --test`: no dedicated tests for these 4 modules; they are
  imported by tested modules (`baileysFactory`, `inbound`, etc.). Suite not run
  per read-only constraint.
- [FAIL] "Do not change `setSockAccessor`'s single-socket contract (that changes
  in Step 16/17)." — `setSockAccessor`/`getSock` were removed; `getGroupContext`
  & `currentBotAliases` now read `ctx.sock`. See Issues.

## (3) Issues

- [MINOR] migration/node/groupContext.ts:1-300 — `setSockAccessor` (and the
  module-level `let getSock`) from the original `src/groupContext.js` was
  removed, not merely typed. `getGroupContext`, `getGroupParticipantName`, and
  `currentBotAliases` now take/read `AccountContext.sock`. This is the
  per-account refactor the step explicitly defers to Step 16/17, so it violates
  the step-07 "Must NOT do" and the "Files to modify … setSockAccessor" line.
  Not a runtime defect: `git grep setSockAccessor -- migration/` returns
  nothing (no stale importers), and the rest of the tree is already ctx-based,
  so retaining the single-socket accessor would in fact be inconsistent. Impact
  is process/scope only.
- [MINOR] migration/node/messageParser.ts:226 / participants.ts / groupContext.ts
  — Public signatures gained a leading `ctx: AccountContext` parameter
  (`extractQuoted(ctx, …)`, `rememberParticipantName(ctx, …)`,
  `getGroupContext(ctx, …)`, etc.), so "Logic unchanged" is true for the
  algorithm but the API surface changed beyond pure typing. Consistent with the
  holistic `AccountContext` migration and with all call sites
  (`wa/inbound.ts`, `baileysFactory.ts`, `wa/events.ts`, `wa/moderation.ts`,
  `actionDispatcher.ts` all pass `ctx`). No correctness issue found.

No BLOCKER or MAJOR issues found.

## (4) Notes — Must NOT do / isolation / contract

- Media size limits, path sandbox, and group TTLs: NOT changed (compliant).
- "Do not convert any other file": the four listed files are the only ones this
  step touched; the broader holistic conversion belongs to other steps' scope.
- `setSockAccessor` single-socket contract: changed ahead of schedule (the one
  real deviation — MINOR, see Issues).
- Per-account isolation: IMPROVED, not leaked. All former module singletons now
  live on `AccountContext` (`messageCache`, `groupMetadataCache`,
  `participantNameCache`, `groupParticipantNameCache`, `groupJoinDedupCache`),
  each created fresh per `createAccountContext`. No shared mutable cross-tenant
  state remains in these four modules.
- Contract: `saveMedia`'s `SavedAttachment` shape (kind/mime/fileName/
  originalFileName/jpegThumbnail/size/path/isAnimated) matches CONTRACT §7
  `WhatsAppMessage.attachments`; no wire shape changed. No WS frame/topology
  code in these modules.
