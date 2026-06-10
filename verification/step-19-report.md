# Step 19 — `actionDispatcher.ts` — Verification Report

## (1) Verdict: ACCURATE

The server-side, per-account action dispatcher was created exactly as specified.
`migration/node/account/actionDispatcher.ts` is a faithful, verbatim-behavior
port of the original `src/index.js` `dispatchCommand` + `emitActionAck` +
`emitActionError` + `deriveKickFailure` + `actionErrorCode` + `actionErrorDetail`,
parameterized by `AccountEntry` (using `entry.ctx` / `entry.sock` and routing
acks via `registry.sendToClient(entry.folderPath, …)`). All action result shapes
and error codes are preserved. The accompanying test exercises the three required
scenarios. Only one stale/misleading doc-comment was found (MINOR, non-functional).

## (2) Acceptance-criteria checklist

| Criterion | Result | Notes |
|-----------|--------|-------|
| `dispatchAction(entry, frame)` exported | PASS | `actionDispatcher.ts` exports `dispatchAction`, `emitActionAck`, `emitActionError`. |
| Identical routing to `dispatchCommand`, using `entry.sock`/`entry.ctx` + account `withJidQueue` | PASS | Every branch (`send_message`, `react_message`, `delete_message`, `kick_member`, `mark_read`, `run_command`, `send_presence`, `relay_lottie_sticker`, `send_quiz`, `send_buttons`, `send_carousel`, `send_copy_code`, fallback) matches `src/index.js` line-for-line with ctx/sock substitution. |
| Acks routed via `registry.sendToClient(entry.folderPath, …)` (best-effort) | PASS | `emitActionAck`/`emitActionError` and inline kick/fallback errors all use `registry.sendToClient` (best-effort, CONTRACT §1.6). |
| Result shapes preserved (CONTRACT §1.3) | PASS | `result.sent` for send_message, `{contextMsgId,messageId}` for quiz, raw kick result, `{command}` for run_command — all identical to original. |
| Kick-failure code derivation (CONTRACT §2) | PASS | `deriveKickFailure` priority `[permission_denied, send_failed, not_found, invalid_target]` ported verbatim. |
| `mark_read`/`send_presence` emit NO ack (CONTRACT §1.2) | PASS | Both branches `await` then `return` with no emit. |
| `pnpm typecheck` zero errors | PASS (static reasoning) | All call sites match ctx-first signatures of `sendOutgoing`, `reactToMessage`, `deleteMessageByContextId`, `kickMembers`, `withJidQueue`, `dispatchRunCommand`, `sendLottieSticker`, and quiz-branch dynamic imports (`resolveQuotedMessage`, `getGroupContext`, `renderOutboundMentions`, `rememberSenderRef`, `nextContextMsgId`, `rememberMessage`). `entry.sock` cast `as any` for interactive senders. Not run (read-only; gated centrally). |
| Test: send_message → A's sock + action_ack(ok, result.sent) + send_ack to A | PASS | `tests/node/action-dispatcher.test.ts` asserts ctx routing, both frames, and account B isolation. |
| Test: kick_member failure → action_ack(ok:false) priority code + error frame | PASS | Asserts `permission_denied` wins over `send_failed`, matching error frame. |
| Test: mark_read → no ack | PASS | Asserts `client.sent.length === 0`. |
| `node --test` green | NOT RUN | Read-only constraint; central gate. Code/logic consistent with passing. |
| Must NOT contain WS server / control-event / Baileys creation code | PASS | None present; module is a leaf dispatcher. |

## (3) Issues

- [MINOR] `migration/node/account/actionDispatcher.ts:17-19` — Stale/incorrect
  doc comment: it states `markChatRead`/`sendPresence` are "NOT ctx-first … called
  with the payload only, exactly as `index.ts` does." In the migrated code they
  ARE ctx-first (`migration/node/wa/presence.ts:5,20` both take `(ctx, payload)`
  and read `ctx.sock`), and the dispatcher correctly calls
  `deps.markChatRead(ctx, payload)` / `deps.sendPresence(ctx, payload)`
  (lines 257, 311). The code is correct; only the comment is misleading.
  No functional impact.

## (4) Notes — Must-NOT / isolation / contract concerns

- "Do not remove `dispatchCommand` from `index.ts` yet" — In the final repo state,
  `migration/node/index.ts` is already the flipped thin bootstrap that delegates
  to `account/actionDispatcher.ts` (no in-file `dispatchCommand`). This removal is
  performed by Step 28, not Step 19. Step 19's own change (creating
  `actionDispatcher.ts`) does not touch `index.ts`, so the Step-19 "Must NOT"
  is not violated; the audited final state simply reflects Step 28.
- "Do not change any action result shape or error code" — Honored; shapes and
  codes are byte-for-byte identical to `src/index.js`.
- "Do not start the WS server" — Honored; no server/listener code.
- Per-account isolation: GOOD. The original module-global `quizMessageIds` is now
  read from `ctx.quizMessageIds` (per-account `Set`, defined in
  `accountContext.ts`); only the bound constant `MAX_QUIZ_IDS` is imported from
  `caches.ts`. No shared mutable state across tenants. The test explicitly proves
  account B's client receives nothing during account A's dispatch.
- Reliable vs best-effort: CORRECT. All acks/errors use `sendToClient`
  (best-effort), matching CONTRACT §1.6 for `action_ack`/`send_ack`/`error`.
- Error-handling: `dispatchAction` wraps `routeAction` in try/catch and converts
  uncaught errors into `emitActionError` (action_ack ok:false + error frame),
  mirroring the original inbound handler wrapper. No error swallowing.
