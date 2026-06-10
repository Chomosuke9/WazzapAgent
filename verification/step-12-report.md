# Step 12 Verification — TypeScript `wa/` consumers

## (1) Verdict: ACCURATE

All seven target modules were converted `.js → .ts`, typed against the Step 09
protocol types, and the `.js` originals deleted. Mention/media-send logic is
preserved verbatim from `src/wa/`. The Step 12 "Must NOT do" items
(no `folderPath` stamping, keep `wsClient.send`) are no longer observable in the
final tree, but this is the **expected** consequence of Steps 18/21 being layered
on top of Step 12 in the cumulative migration — not a defect of the conversion
itself (see Notes). All Step-12-scoped goals are satisfied.

## (2) Acceptance-criteria checklist

| Criterion | Result | Evidence |
|---|---|---|
| 7 files renamed to `.ts`, 7 `.js` deleted | PASS | `migration/node/wa/` contains `actions.ts moderation.ts presence.ts runCommand.ts outbound.ts events.ts inbound.ts`; `ls *.js` empty; `git status` clean. |
| `actions.ts`: `reactToMessage`, `deleteMessageByContextId`, `actionError(code: ErrorCode, …)` typed | PASS | `ActionError = Error & { code: ErrorCode; detail? }`; both fns have typed params + return shapes. |
| `moderation.ts`: `kickMembers` → `ActionResult` | PASS (loose) | Returns `{ ok, mode, results } as ActionResult`. Note: `ActionResult` has no dedicated `kick_member` variant; this resolves via the `Record<string, unknown>` catch-all member. Valid but permissive. |
| `presence.ts`: `markChatRead`, `sendPresence` typed | PASS | Uses `MarkReadPayload` / `SendPresencePayload` from protocol/types. |
| `runCommand.ts`: `dispatchRunCommand` → `{ ok, detail, command }` | PASS | Returns `{ ok: boolean; command: string \| null; detail: string }` (field order differs from spec text, shape matches). |
| `outbound.ts`: `sendOutgoing` → `{ sent: SentEntry[]; replyTo: string \| null }`; `renderOutboundMentions`, `sendLottieSticker` typed | PASS | Return annotated exactly as specified; `RenderedMentions` interface; `sendLottieSticker` returns `{ contextMsgId; messageId: string\|null }`. |
| `events.ts`: three emitters typed; payload typed | PASS | `emitGroupJoinContextEvent`, `emitBotActionContextEvent`, `emitBotRoleChangeEvent` all typed with explicit arg interfaces. |
| `inbound.ts`: `handleIncomingMessage` / `handleGroupParticipantsUpdate` typed; `payload` as `WhatsAppMessagePayload` | PASS | `const payload: WhatsAppMessagePayload = {…}`; `Attachment[]`, mention types imported. |
| `pnpm typecheck` passes | NOT RUN (global gate) — static reading shows all imported types exist and resolve; no obvious type errors. Likely PASS. |
| `pnpm dev` round-trip | NOT RUN (forbidden — server). |
| `node --test` passes | NOT RUN (forbidden — full suite). |

## (3) Issues

- [MINOR] `migration/node/wa/moderation.ts:~300` — `kickMembers` returns
  `{ ok, mode, results } as ActionResult`; the `ActionResult` union has no
  explicit `kick_member` member, so the cast only succeeds via the
  `Record<string, unknown>` catch-all. Typechecks, but the spec's
  "`ActionResult.kick_member` shape" is not a named variant. Cosmetic typing
  looseness, no runtime impact.
- [MINOR] `migration/node/wa/presence.ts:24` — comment says `type` may be
  `'recording'`, but `SendPresencePayload.type` is `"composing" | "paused"`.
  Code defends with `type || 'composing'`; harmless stale comment.
- [MINOR] `migration/node/wa/outbound.ts:~590` — `logger.debug('outbound', {…})`
  passes a string as the first arg (pino expects `(obj, msg)`). Verified this is
  **preserved verbatim** from `src/wa/outbound.js:499`; not introduced by Step 12.

No BLOCKER or MAJOR issues found. No logic errors, missing imports, isolation
leaks, or contract violations attributable to Step 12. All `wa/*` helpers take
`ctx`/`entry` (per-account), with no shared mutable module state; no leftover
`wsClient`/`getSock`/`sendReliable` references remain.

## (4) Notes on "Must NOT do" / isolation / contract

- "Do not stamp `folderPath` onto payloads (Step 18)": the final code DOES stamp
  `folderPath` (`inbound.ts` sets `folderPath: entry.folderPath`; `eventForwarder.forwardIncoming`
  assigns `payload.folderPath = entry.folderPath`). This is the **Step 18**
  change correctly applied later in the cumulative migration, not a Step 12
  defect. The Step 12 type-conversion boundary is simply no longer isolable in
  the committed tree.
- "Do not replace `wsClient.send`/`sendReliable` with a registry call (Steps 18/21)":
  the final code routes `incoming_message` via
  `forwardIncoming(registry.getOrCreate(ctx.folderPath), payload)` (best-effort,
  via `registry.sendToClient`) — again the expected Step 18/21 end-state. The
  best-effort guarantee for `incoming_message` (CONTRACT §1.6) is honored.
- "Do not change mention-rendering or media-send logic": confirmed unchanged —
  `renderOutboundMentions`, attachment mimetype/filename/thumbnail handling, and
  `sendLottieSticker` relay logic match the original `src/wa/outbound.js`.
- Per-account isolation: `AccountContext` carries `folderPath`, `sock`, and all
  per-tenant caches/registries; the converted modules thread `ctx`/`entry`
  consistently, so no cross-tenant state leakage was introduced.
