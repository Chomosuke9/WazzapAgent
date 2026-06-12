/**
 * actionDispatcher.ts — Server-side, per-account action router (Step 19).
 *
 * This is the multi-account realization of `index.ts`'s `dispatchCommand`
 * (plus its `emitActionAck`/`emitActionError` helpers). The routing logic is a
 * VERBATIM port of today's single-connection dispatcher, with three
 * substitutions so it executes against the correct tenant:
 *
 *   - the global `getActiveContext()` is replaced by `entry.ctx`;
 *   - the global socket accessor (used inline for quiz/buttons/carousel/copy-code)
 *     is replaced by `entry.sock`;
 *   - acks/errors are sent via `registry.sendToClient(entry.folderPath, …)`
 *     (best-effort) instead of a single shared client.
 *
 * The `wa/*` modules that were made ctx-first in Step 16 (`sendOutgoing`,
 * `reactToMessage`, `deleteMessageByContextId`, `kickMembers`,
 * `sendLottieSticker`, `dispatchRunCommand`, `withJidQueue`) are reused exactly
 * as `index.ts` uses them, threading `entry.ctx`. `markChatRead` / `sendPresence`
 * are NOT ctx-first (they still resolve the socket internally) so they are
 * called with the payload only, exactly as `index.ts` does — and they emit NO
 * ack (CONTRACT.md §1.2).
 *
 * This module is a LEAF dispatcher: it does NOT start the WS server (Step 20),
 * emit control events (Step 21), or create Baileys sockets (Step 17). The live
 * `index.ts` keeps its own `dispatchCommand` copy until the flip (Step 28).
 *
 * The `wa/*` calls that touch the network are reachable through an optional
 * injectable `deps` seam (defaulting to the real modules) so the unit test can
 * run offline and assert on the frames sent to the registry client.
 */
import logger from '../logger.js';
import * as registry from '../server/accountRegistry.js';
import {
  sendOutgoing,
  sendLottieSticker,
  reactToMessage,
  deleteMessageByContextId,
  kickMembers,
  markChatRead,
  sendPresence,
  sendNativeFlow,
  sendCarousel,
} from '../wa/index.js';
import { dispatchRunCommand } from '../wa/runCommand.js';
import { withJidQueue } from '../wa/sendQueue.js';
import { sendCopyCode, sendQuickReply } from '../wa/interactive/index.js';
import {
  normalizeJid,
  resolveQuotedMessage,
  nextContextMsgId,
  rememberMessage,
  rememberSenderRef,
} from '../wa/domain/identifiers.js';
import { renderOutboundMentions } from '../wa/outbound.js';
import { getGroupContext } from '../wa/domain/groupContext.js';
import { MAX_QUIZ_IDS } from '../wa/domain/caches.js';
import type {
  AccountEntry,
  InboundActionFrame,
  ActionAckPayload,
  ActionResult,
  WsErrorPayload,
  ErrorCode,
} from '../protocol/types.js';
import type { WaSocketLike } from '../protocol/ports.js';

// ---- error-code derivation (verbatim from index.ts) -----------------------

function actionErrorCode(err: unknown): string {
  if (!err || typeof err !== 'object') return 'send_failed';
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code.trim()) return code;
  return 'send_failed';
}

function actionErrorDetail(err: unknown): string {
  if (!err || typeof err !== 'object') return 'unknown error';
  const detail = (err as { detail?: unknown }).detail;
  if (typeof detail === 'string' && detail.trim()) return detail;
  const message = (err as { message?: unknown }).message;
  if (typeof message === 'string' && message.trim()) return message;
  return 'unknown error';
}

function deriveKickFailure(result: any): { code: ErrorCode; detail: string } {
  const rows = Array.isArray(result?.results) ? result.results : [];
  const failures = rows.filter((row: any) => !row?.ok);
  if (failures.length === 0) {
    return { code: 'send_failed', detail: 'no targets were kicked' };
  }

  const codes = failures
    .map((row: any) => (typeof row?.error === 'string' ? row.error : null))
    .filter(Boolean);
  const priority = ['permission_denied', 'send_failed', 'not_found', 'invalid_target'];
  const code = priority.find((candidate) => codes.includes(candidate)) || codes[0] || 'send_failed';

  const detail = failures.find((row: any) => typeof row?.detail === 'string' && row.detail.trim())?.detail
    || 'no targets were kicked';
  return { code: code as ErrorCode, detail };
}

// ---- ack / error emitters (route via registry) ----------------------------

interface EmitActionAckArgs {
  requestId?: string;
  action: string;
  ok: boolean;
  detail?: string;
  result?: unknown;
  code?: ErrorCode | string | null;
}

/**
 * Emit an `action_ack` (and, for a successful `send_message`, the legacy
 * `send_ack`) to the account's bound Python client. Best-effort: dropped by
 * `registry.sendToClient` if no client is bound / OPEN.
 */
export function emitActionAck(
  entry: AccountEntry,
  { requestId, action, ok, detail, result = null, code = null }: EmitActionAckArgs,
): void {
  const payload: ActionAckPayload = {
    requestId: requestId as string,
    action,
    ok: Boolean(ok),
    detail: detail || (ok ? 'ok' : 'failed'),
  };
  if (result && typeof result === 'object') payload.result = result as ActionResult;
  if (code) payload.code = code as ErrorCode;
  registry.sendToClient(entry.folderPath, { type: 'action_ack', payload });
  if (action === 'send_message' && ok) {
    registry.sendToClient(entry.folderPath, {
      type: 'send_ack',
      payload: { requestId: requestId as string },
    });
  }
}

interface EmitActionErrorArgs {
  requestId?: string;
  action: string;
  err: unknown;
}

/**
 * Emit a failure `action_ack` (ok=false) plus a matching `error` frame to the
 * account's bound Python client.
 */
export function emitActionError(
  entry: AccountEntry,
  { requestId, action, err }: EmitActionErrorArgs,
): void {
  const code = actionErrorCode(err);
  const detail = actionErrorDetail(err);
  emitActionAck(entry, { requestId, action, ok: false, detail, code });
  const payload: WsErrorPayload = {
    message: `${action} failed`,
    detail,
    code: code as ErrorCode,
    requestId,
    action,
  };
  registry.sendToClient(entry.folderPath, { type: 'error', payload });
}

// ---- injectable wa/* seam -------------------------------------------------

/**
 * The set of `wa/*` functions the router calls directly. Defaults to the real
 * modules; tests may override individual members so the dispatcher runs
 * offline. (Quiz/copy-code internals use dynamic imports verbatim, as in
 * `index.ts`, and are not part of this seam.)
 */
export interface DispatchDeps {
  withJidQueue: typeof withJidQueue;
  sendOutgoing: typeof sendOutgoing;
  reactToMessage: typeof reactToMessage;
  deleteMessageByContextId: typeof deleteMessageByContextId;
  kickMembers: typeof kickMembers;
  markChatRead: typeof markChatRead;
  sendPresence: typeof sendPresence;
  sendLottieSticker: typeof sendLottieSticker;
  sendNativeFlow: typeof sendNativeFlow;
  sendCarousel: typeof sendCarousel;
  dispatchRunCommand: typeof dispatchRunCommand;
}

const DEFAULT_DEPS: DispatchDeps = {
  withJidQueue,
  sendOutgoing,
  reactToMessage,
  deleteMessageByContextId,
  kickMembers,
  markChatRead,
  sendPresence,
  sendLottieSticker,
  sendNativeFlow,
  sendCarousel,
  dispatchRunCommand,
};

// ---- router (verbatim behavior, parameterized by AccountEntry) ------------

// ---- per-action handlers + dispatch map (Step 07) ------------------------
//
// Each former `if (type === …)` branch of the old ~270-line `routeAction`
// if/else chain is now a single-purpose handler keyed by action type in
// {@link ACTION_HANDLERS} (mirrors the Step-06 command registry). `routeAction`
// is reduced to a map lookup. Behavior is a verbatim port — the handler bodies
// are unchanged except for being parameterized by `(entry, payload, requestId,
// deps)` and using the now-static (formerly dynamic) `wa/*` imports.

/** A single action handler. `payload` is the loose wire payload (as before). */
type ActionHandler = (
  entry: AccountEntry,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any,
  requestId: string | undefined,
  deps: DispatchDeps,
) => Promise<void>;

const handleSendMessage: ActionHandler = async (entry, payload, requestId, deps) => {
  const ctx = entry.ctx;
  const result = await deps.withJidQueue(ctx, payload.chatId, () => deps.sendOutgoing(ctx, payload));
  emitActionAck(entry, { requestId, action: 'send_message', ok: true, detail: 'sent', result });
};

const handleReactMessage: ActionHandler = async (entry, payload, requestId, deps) => {
  const result = await deps.reactToMessage(entry.ctx, payload);
  emitActionAck(entry, { requestId, action: 'react_message', ok: true, detail: 'reacted', result });
};

const handleDeleteMessage: ActionHandler = async (entry, payload, requestId, deps) => {
  const result = await deps.deleteMessageByContextId(entry.ctx, payload);
  emitActionAck(entry, { requestId, action: 'delete_message', ok: true, detail: 'deleted', result });
};

const handleKickMember: ActionHandler = async (entry, payload, requestId, deps) => {
  const result: any = await deps.kickMembers(entry.ctx, payload);
  const ok = Boolean(result?.ok);
  if (ok) {
    emitActionAck(entry, { requestId, action: 'kick_member', ok: true, detail: 'kick applied', result });
    return;
  }

  const failure = deriveKickFailure(result);
  emitActionAck(entry, {
    requestId,
    action: 'kick_member',
    ok: false,
    detail: failure.detail,
    result,
    code: failure.code,
  });
  registry.sendToClient(entry.folderPath, {
    type: 'error',
    payload: {
      message: 'kick_member failed',
      detail: failure.detail,
      code: failure.code,
      requestId,
      action: 'kick_member',
    },
  });
};

const handleMarkRead: ActionHandler = async (entry, payload, _requestId, deps) => {
  await deps.markChatRead(entry.ctx, payload);
};

const handleSendPresence: ActionHandler = async (entry, payload, _requestId, deps) => {
  await deps.sendPresence(entry.ctx, payload);
};

const handleRunCommand: ActionHandler = async (entry, payload, requestId, deps) => {
  // LLM2 self-triggered slash command (no WhatsApp echo). The actual
  // dispatch lives in wa/runCommand.ts to keep the router thin. We always
  // emit an action_ack so Python can append a synthetic "Command X
  // executed/failed" line to LLM history.
  let result: any;
  try {
    result = await deps.dispatchRunCommand(entry.ctx, payload);
  } catch (err) {
    const detail = actionErrorDetail(err);
    emitActionAck(entry, {
      requestId,
      action: 'run_command',
      ok: false,
      detail,
      result: { command: null, error: detail },
      code: actionErrorCode(err),
    });
    return;
  }
  emitActionAck(entry, {
    requestId,
    action: 'run_command',
    ok: Boolean(result?.ok),
    detail: result?.detail || (result?.ok ? 'executed' : 'failed'),
    result: { command: result?.command || null },
    code: result?.ok ? null : 'invalid_target',
  });
};

const handleRelayLottieSticker: ActionHandler = async (entry, payload, requestId, deps) => {
  // Relay a Lottie/premium sticker using its stored JSON payload.
  // Python bridge sends this when resolve_sticker() returns a lottie_payload.
  const { chatId, lottiePayload, replyTo, requestId: rid } = payload;
  try {
    const result = await deps.sendLottieSticker(entry.ctx, chatId, lottiePayload, replyTo);
    emitActionAck(entry, {
      requestId: rid || requestId,
      action: 'relay_lottie_sticker',
      ok: true,
      detail: 'sent',
      result,
    });
  } catch (err) {
    emitActionError(entry, { requestId: rid || requestId, action: 'relay_lottie_sticker', err });
  }
};

const handleSendQuiz: ActionHandler = async (entry, payload, requestId) => {
  const ctx = entry.ctx;
  const sock = entry.sock;
  if (!sock) throw new Error('WhatsApp socket not ready');
  const { chatId, question, choices, replyTo, footer, requestId: rid } = payload;
  try {
    // Body is exactly what the LLM wrote in `question` — no auto-appending of choices.
    // The LLM already included the choices in the question text however it sees fit.
    // Resolve @Name (senderRef) mention tokens to JIDs, same as sendOutgoing() does
    // for plain text replies.
    const isGroup = chatId?.endsWith('@g.us');
    const group = isGroup ? await getGroupContext(ctx, chatId) : null;
    const rendered = await renderOutboundMentions(ctx, chatId, question, group);

    // Build buttons: display_text = ch.text as-is (LLM writes full label in text)
    // id = "qz:<label>" so inbound handler can route it
    const buttons = choices.map((ch: any) => ({
      id: `qz:${ch.label}`,
      displayText: ch.text,
    }));

    const quoted: any = replyTo ? resolveQuotedMessage(ctx, chatId, replyTo) : null;
    const sentMsg = await sendQuickReply(sock, chatId, rendered.text, buttons, {
      footer: footer || '',
      quoted: quoted || undefined,
      mentions: rendered.mentions,
      nonJidMentions: rendered.nonJidMentions,
    });

    const botSenderId = normalizeJid(sock.user?.id) || 'bot@wazzap.local';
    const botSenderRef = rememberSenderRef(ctx, chatId, botSenderId, botSenderId) || 'unknown';
    const contextMsgId = nextContextMsgId(ctx, chatId);
    rememberMessage(ctx, sentMsg, {
      chatId,
      contextMsgId,
      senderId: botSenderId,
      senderRef: botSenderRef,
      senderIsAdmin: false,
      fromMe: true,
      timestampMs: Date.now(),
    });

    // Track this message ID so inbound.ts can distinguish a plain-text
    // reply to a quiz from a reply to a settings menu (both are
    // interactiveMessage type; only quiz replies should reach the LLM).
    const quizMessageIds = ctx.quizMessageIds;
    const quizMsgId = sentMsg?.key?.id;
    if (quizMsgId) {
      quizMessageIds.add(quizMsgId);
      // Bounded eviction: drop oldest entries when the set grows too large.
      if (quizMessageIds.size > MAX_QUIZ_IDS) {
        quizMessageIds.delete(quizMessageIds.values().next().value as string);
      }
    }

    emitActionAck(entry, {
      requestId: rid || requestId,
      action: 'send_quiz',
      ok: true,
      detail: 'sent',
      result: { contextMsgId, messageId: sentMsg?.key?.id || null },
    });
  } catch (err) {
    emitActionError(entry, { requestId: rid || requestId, action: 'send_quiz', err });
  }
};

const handleSendButtons: ActionHandler = async (entry, payload, requestId, deps) => {
  const sock = entry.sock;
  const nativeButtons = (payload.buttons || []).map((btn: any) => ({
    name: btn.name,
    buttonParamsJson: typeof btn.buttonParams === 'object'
      ? JSON.stringify(btn.buttonParams)
      : (btn.buttonParamsJson || '{}'),
  }));
  const result = await deps.sendNativeFlow(sock as WaSocketLike, payload.chatId, payload.text || '', nativeButtons, { footer: payload.footer });
  emitActionAck(entry, { requestId, action: 'send_buttons', ok: true, detail: 'sent', result });
};

const handleSendCarousel: ActionHandler = async (entry, payload, requestId, deps) => {
  const sock = entry.sock;
  const cards = (payload.cards || []).map((card: any) => ({
    ...(card.image ? { image: card.image } : {}),
    ...(card.video ? { video: card.video } : {}),
    body: typeof card.body === 'object' ? (card.body.text || '') : (card.body || ''),
    footer: typeof card.footer === 'object' ? (card.footer.text || '') : (card.footer || ''),
    buttons: (card.buttons || []).map((btn: any) => ({
      name: btn.name,
      buttonParamsJson: typeof btn.buttonParams === 'object'
        ? JSON.stringify(btn.buttonParams)
        : (btn.buttonParamsJson || '{}'),
    })),
  }));
  const result = await deps.sendCarousel(sock as WaSocketLike, payload.chatId, cards, { text: payload.text });
  emitActionAck(entry, { requestId, action: 'send_carousel', ok: true, detail: 'sent', result });
};

const handleSendCopyCode: ActionHandler = async (entry, payload, requestId, deps) => {
  const ctx = entry.ctx;
  const sock = entry.sock;
  if (!sock) throw new Error('WhatsApp socket not ready');
  const { chatId, code, displayText, quotedPreviewText } = payload;
  // When quotedPreviewText is provided, create a synthetic quoted
  // message with a dummy stanzaId so the CTA Copy bubble shows a
  // reply preview containing the code snippet.  The dummy ID does
  // not correspond to any real message — WhatsApp only renders the
  // quotedMessage content as the preview text.
  let quoted: any = null;
  if (quotedPreviewText && chatId) {
    const botJid = normalizeJid(sock.user?.id) || 'bot@wazzap.local';
    quoted = {
      key: {
        remoteJid: chatId,
        fromMe: true,
        id: `CPY_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        participant: botJid,
      },
      message: { conversation: quotedPreviewText },
    };
  }
  try {
    const result = await deps.withJidQueue(ctx, chatId, () =>
      sendCopyCode(sock, chatId, '', code, displayText || 'Copy Code', {
        badge: false,
        ...(quoted ? { quoted } : {}),
      }),
    );
    emitActionAck(entry, { requestId, action: 'send_copy_code', ok: true, detail: 'sent', result });
  } catch (err) {
    emitActionError(entry, { requestId, action: 'send_copy_code', err });
  }
};

/**
 * Action-type → handler map. Adding an action means adding one handler and one
 * entry here (no growing if/else chain). Mirrors the Step-06 command registry.
 */
const ACTION_HANDLERS: Record<string, ActionHandler> = {
  send_message: handleSendMessage,
  react_message: handleReactMessage,
  delete_message: handleDeleteMessage,
  kick_member: handleKickMember,
  mark_read: handleMarkRead,
  send_presence: handleSendPresence,
  run_command: handleRunCommand,
  relay_lottie_sticker: handleRelayLottieSticker,
  send_quiz: handleSendQuiz,
  send_buttons: handleSendButtons,
  send_carousel: handleSendCarousel,
  send_copy_code: handleSendCopyCode,
};

/**
 * Route one inbound action frame to its handler (verbatim behavior, now a map
 * lookup instead of an if/else chain). Unknown non-`hello` types produce the
 * same `unsupported command` error frame as before.
 */
async function routeAction(
  entry: AccountEntry,
  frame: InboundActionFrame,
  deps: DispatchDeps,
): Promise<void> {
  const msg: { type?: string; payload?: any } = frame;
  const payload: any = msg?.payload || {};
  const requestId: string | undefined = payload.requestId;
  const type = msg?.type;

  const handler = type ? ACTION_HANDLERS[type] : undefined;
  if (handler) {
    await handler(entry, payload, requestId, deps);
    return;
  }

  if (type && type !== 'hello') {
    registry.sendToClient(entry.folderPath, {
      type: 'error',
      payload: {
        message: `unsupported command: ${type}`,
        detail: 'command not implemented by gateway',
        code: 'invalid_target',
        requestId,
        action: type,
      },
    });
  }
}

/**
 * Execute one inbound action frame against `entry` (its Baileys socket + ctx),
 * routing all acks/errors back to the account's bound client. Uncaught errors
 * from the router are turned into a failure `action_ack` + `error` frame
 * (mirroring `index.ts`'s inbound action-frame handler wrapper).
 */
export async function dispatchAction(
  entry: AccountEntry,
  frame: InboundActionFrame,
  deps: Partial<DispatchDeps> = {},
): Promise<void> {
  const merged: DispatchDeps = { ...DEFAULT_DEPS, ...deps };
  try {
    await routeAction(entry, frame, merged);
  } catch (err) {
    const action = (frame as any)?.type;
    logger.error({ err, action, folderPath: entry.folderPath }, 'failed handling ws action');
    emitActionError(entry, {
      requestId: (frame as any)?.payload?.requestId,
      action,
      err,
    });
  }
}
