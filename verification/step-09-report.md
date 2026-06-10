# Step 09 Verification — `migration/node/protocol/types.ts`

## 1. Verdict: ACCURATE

The implemented `migration/node/protocol/types.ts` faithfully reproduces
CONTRACT.md §5 (TypeScript Types) verbatim, fleshes out `WhatsAppMessagePayload`
field-by-field per CONTRACT.md §7, uses the §2 `ErrorCode` set, and emits no
runtime code. All required exports are present. Two minor deviations from the
spec's literal wording are noted below; neither is a functional bug.

## 2. Acceptance-criteria checklist

| Criterion | Result | Notes |
|-----------|--------|-------|
| `pnpm typecheck` passes with zero errors | PASS (static judgement) | tsconfig `include` is `migration/node/**/*`; types.ts is type-only and its single `import type { AccountContext } from "../account/accountContext.js"` resolves (file exists, exports the interface, no back-import → no cycle). |
| `node -e "...accessSync('src/protocol/types.ts')"` succeeds | N/A / stale path | The criterion's path `src/protocol/types.ts` is a pre-migration leftover. The migration-correct file exists at `migration/node/protocol/types.ts`. Treated as a stale criterion, not an impl defect. |
| `tests/node/protocol-types.test.ts` constructs one literal of each `*Payload` and assigns into the union; compiles | PASS | File exists and does exactly this for all inbound/outbound payloads and both unions. Runs via `tsx` (`pnpm test`). |
| Importing `OutboundFrame`/`InboundFrame` from another `.ts` resolves | PASS | The test imports both union types from `../../migration/node/protocol/types.ts`. |

### Exports presence (all required §5 names)
WaStatus, ErrorCode, Attachment, HelloPayload, SendMessagePayload,
ReactMessagePayload, DeleteMessagePayload, KickMemberPayload (+KickTarget),
MarkReadPayload, SendPresencePayload, SendQuizPayload (+QuizChoice),
SendCopyCodePayload, RelayLottieStickerPayload, SendButtonsPayload
(+NativeButton), SendCarouselPayload (+CarouselCard), RunCommandPayload,
InboundActionFrame, InboundFrame, HelloAckPayload, SentEntry, ActionResult,
ActionAckPayload, SendAckPayload, WsErrorPayload, WhatsAppStatusPayload,
WhatsAppMessagePayload, OutboundFrame, AccountEntry, BaileysFactoryOptions —
**all present.** PASS.

### "Must NOT contain" checks
- No runtime/value exports: PASS — only `export type` / `export interface` /
  `import type` / `export type { AccountContext }` (all erased at compile).
- No validation/encode-decode logic: PASS.
- No re-definition of baileys/ws types: PASS — referenced via
  `import("baileys").WASocket` and `import("ws").WebSocket`.

## 3. Issues

- [MINOR] migration/node/protocol/types.ts:191-193 — `AccountContext` is
  provided via `import type { AccountContext } from "../account/accountContext.js"`
  + `export type { AccountContext }` rather than the spec's literally-instructed
  opaque placeholder `export interface AccountContext { /* defined in Step 16 */ }`.
  This deviates from the spec's "Key logic" wording and makes the file depend on
  Step 16's module (the spec only lists "Depends on Step 05"). However it is
  functionally equivalent/superior in the integrated tree (the real interface
  exists, no duplicate/empty placeholder, no import cycle) and the spec's stated
  goal ("so the file compiles") is met. Not a bug.
- [MINOR] migration/node/protocol/types.ts:150 — `WhatsAppMessagePayload.attachments`
  is typed as the §5 `Attachment[]` (`{kind, path, fileName?, caption?, mime?,
  thumbnailBase64?}`). CONTRACT §7's *description* column lists inbound
  attachment fields `{kind, mime, fileName, originalFileName?, size, path,
  isAnimated?, jpegThumbnail?}` which the shared `Attachment` type does not
  capture (and adds `caption`/`thumbnailBase64` that inbound lacks). This is a
  pre-existing CONTRACT ambiguity (§7's table column literally types the field
  as `Attachment[]`), so the implementation followed the only defined
  `Attachment` type. Cosmetic / contract-level, not a step-09 defect.

## 4. "Must NOT do" / isolation / contract notes
- "Do not import this from any production module yet": types.ts itself is not
  imported by any production module here. (types.ts importing accountContext is
  the reverse direction; the spec clause targets other modules importing
  types.ts. Worth a glance by Step 16 owners but not a violation.)
- "Do not add encode/decode functions": respected (no serializer).
- "Do not define AccountContext's real fields (Step 16)": respected — fields are
  defined in `account/accountContext.ts`, re-exported here.
- Control events (`clear_history`, `set_llm2_model`, `invalidate_*`,
  `set_subagent_enabled`) are modeled with **top-level** `folderPath`/`chatId`
  fields and no `payload` wrapper — matches CONTRACT §1.5/§5. Event/action frames
  use the `{type, payload}` shape. Frame shapes are contract-correct.
- `set_llm2_model.modelId` typed `string | null` and `whatsapp_status.reason?`
  optional `number` — consistent with §5/§1.4.

## Summary
Static reading against CONTRACT §5/§7/§2 confirms the module is an accurate,
type-only realization of the wire contract with every required export. Verified:
all §5 declarations match verbatim; all §7 fields present with correct
Always/Optional `?` markers; no runtime emission; the protocol-types test and
union re-export resolve. Only two MINOR, non-blocking deviations from spec
wording (AccountContext re-export vs placeholder; attachment field richness).
