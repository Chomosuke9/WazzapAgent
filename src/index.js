import logger from './logger.js';
import wsClient from './wsClient.js';
import { init as dbInit, closeAllDbs } from './db.js';
import {
  startWhatsApp,
  sendOutgoing,
  sendLottieSticker,
  reactToMessage,
  deleteMessageByContextId,
  kickMembers,
  markChatRead,
  sendPresence,
  sendNativeFlow,
  sendCarousel,
} from './wa/index.js';
import { getSock } from './wa/connection.js';
import { dispatchRunCommand } from './wa/runCommand.js';
import { withJidQueue } from './wa/sendQueue.js';
import { sendCopyCode } from './wa/interactive/index.js';
import { normalizeJid } from './identifiers.js';
import config from './config.js';

function actionErrorCode(err) {
  if (!err || typeof err !== 'object') return 'send_failed';
  if (typeof err.code === 'string' && err.code.trim()) return err.code;
  return 'send_failed';
}

function actionErrorDetail(err) {
  if (!err || typeof err !== 'object') return 'unknown error';
  if (typeof err.detail === 'string' && err.detail.trim()) return err.detail;
  if (typeof err.message === 'string' && err.message.trim()) return err.message;
  return 'unknown error';
}

function deriveKickFailure(result) {
  const rows = Array.isArray(result?.results) ? result.results : [];
  const failures = rows.filter((row) => !row?.ok);
  if (failures.length === 0) {
    return { code: 'send_failed', detail: 'no targets were kicked' };
  }

  const codes = failures
    .map((row) => (typeof row?.error === 'string' ? row.error : null))
    .filter(Boolean);
  const priority = ['permission_denied', 'send_failed', 'not_found', 'invalid_target'];
  const code = priority.find((candidate) => codes.includes(candidate)) || codes[0] || 'send_failed';

  const detail = failures.find((row) => typeof row?.detail === 'string' && row.detail.trim())?.detail
    || 'no targets were kicked';
  return { code, detail };
}

function emitActionAck({
  requestId,
  action,
  ok,
  detail,
  result = null,
  code = null,
}) {
  const payload = {
    requestId,
    action,
    ok: Boolean(ok),
    detail: detail || (ok ? 'ok' : 'failed'),
  };
  if (result && typeof result === 'object') payload.result = result;
  if (code) payload.code = code;
  wsClient.send({ type: 'action_ack', payload });
  if (action === 'send_message' && ok) {
    wsClient.send({ type: 'send_ack', payload: { requestId } });
  }
}

function emitActionError({
  requestId,
  action,
  err,
}) {
  const code = actionErrorCode(err);
  const detail = actionErrorDetail(err);
  emitActionAck({ requestId, action, ok: false, detail, code });
  wsClient.send({
    type: 'error',
    payload: {
      message: `${action} failed`,
      detail,
      code,
      requestId,
      action,
    },
  });
}

async function dispatchCommand(msg) {
  const payload = msg?.payload || {};
  const requestId = payload.requestId;
  const type = msg?.type;

  if (type === 'send_message') {
    const result = await withJidQueue(payload.chatId, () => sendOutgoing(payload));
    emitActionAck({ requestId, action: 'send_message', ok: true, detail: 'sent', result });
    return;
  }

  if (type === 'react_message') {
    const result = await reactToMessage(payload);
    emitActionAck({ requestId, action: 'react_message', ok: true, detail: 'reacted', result });
    return;
  }

  if (type === 'delete_message') {
    const result = await deleteMessageByContextId(payload);
    emitActionAck({ requestId, action: 'delete_message', ok: true, detail: 'deleted', result });
    return;
  }

  if (type === 'kick_member') {
    const result = await kickMembers(payload);
    const ok = Boolean(result?.ok);
    if (ok) {
      emitActionAck({ requestId, action: 'kick_member', ok: true, detail: 'kick applied', result });
      return;
    }

    const failure = deriveKickFailure(result);
    emitActionAck({
      requestId,
      action: 'kick_member',
      ok: false,
      detail: failure.detail,
      result,
      code: failure.code,
    });
    wsClient.send({
      type: 'error',
      payload: {
        message: 'kick_member failed',
        detail: failure.detail,
        code: failure.code,
        requestId,
        action: 'kick_member',
      },
    });
    return;
  }

  if (type === 'mark_read') {
    await markChatRead(payload);
    return;
  }

  if (type === 'run_command') {
    // LLM2 self-triggered slash command (no WhatsApp echo). The actual
    // dispatch lives in src/wa/runCommand.js to keep the index router
    // thin. We always emit an action_ack so Python can append a
    // synthetic "Command X executed/failed" line to LLM history.
    let result;
    try {
      result = await dispatchRunCommand(payload);
    } catch (err) {
      const detail = actionErrorDetail(err);
      emitActionAck({
        requestId,
        action: 'run_command',
        ok: false,
        detail,
        result: { command: null, error: detail },
        code: actionErrorCode(err),
      });
      return;
    }
    emitActionAck({
      requestId,
      action: 'run_command',
      ok: Boolean(result?.ok),
      detail: result?.detail || (result?.ok ? 'executed' : 'failed'),
      result: { command: result?.command || null },
      code: result?.ok ? null : 'invalid_target',
    });
    return;
  }

  if (type === 'send_presence') {
    await sendPresence(payload);
    return;
  }

  if (type === 'relay_lottie_sticker') {
    // Relay a Lottie/premium sticker using its stored JSON payload.
    // Python bridge sends this when resolve_sticker() returns a lottie_payload.
    const { chatId, lottiePayload, replyTo, requestId: rid } = payload;
    try {
      const result = await sendLottieSticker(chatId, lottiePayload, replyTo);
      emitActionAck({
        requestId: rid || requestId,
        action: 'relay_lottie_sticker',
        ok: true,
        detail: 'sent',
        result,
      });
    } catch (err) {
      emitActionError({ requestId: rid || requestId, action: 'relay_lottie_sticker', err });
    }
    return;
  }

  if (type === 'send_quiz') {
    const sock = getSock();
    if (!sock) throw new Error('WhatsApp socket not ready');
    const { chatId, question, choices, replyTo, footer, requestId: rid } = payload;
    try {
      const { sendQuickReply } = await import('./wa/interactive/index.js');
      const { resolveQuotedMessage } = await import('./identifiers.js');
      const { normalizeJid, nextContextMsgId, rememberMessage, rememberSenderRef } = await import('./identifiers.js');

      // Body is exactly what the LLM wrote in `question` — no auto-appending of choices.
      // The LLM already included the choices in the question text however it sees fit.
      // Resolve @Name (senderRef) mention tokens to JIDs, same as sendOutgoing() does
      // for plain text replies.
      const { renderOutboundMentions } = await import('./wa/outbound.js');
      const isGroup = chatId?.endsWith('@g.us');
      const { getGroupContext } = await import('./groupContext.js');
      const group = isGroup ? await getGroupContext(chatId) : null;
      const rendered = await renderOutboundMentions(chatId, question, group);

      // Build buttons: display_text = ch.text as-is (LLM writes full label in text)
      // id = "qz:<label>" so inbound handler can route it
      const buttons = choices.map((ch) => ({
        id: `qz:${ch.label}`,
        displayText: ch.text,
      }));

      const quoted = replyTo ? resolveQuotedMessage(chatId, replyTo) : null;
      const sentMsg = await sendQuickReply(sock, chatId, rendered.text, buttons, {
        footer: footer || '',
        quoted: quoted || undefined,
        mentions: rendered.mentions,
        nonJidMentions: rendered.nonJidMentions,
      });

      const botSenderId = normalizeJid(sock.user?.id) || 'bot@wazzap.local';
      const botSenderRef = rememberSenderRef(chatId, botSenderId, botSenderId) || 'unknown';
      const contextMsgId = nextContextMsgId(chatId);
      rememberMessage(sentMsg, {
        chatId,
        contextMsgId,
        senderId: botSenderId,
        senderRef: botSenderRef,
        senderIsAdmin: false,
        fromMe: true,
        timestampMs: Date.now(),
      });

      // Track this message ID so inbound.js can distinguish a plain-text
      // reply to a quiz from a reply to a settings menu (both are
      // interactiveMessage type; only quiz replies should reach the LLM).
      const { quizMessageIds, MAX_QUIZ_IDS } = await import('./caches.js');
      const quizMsgId = sentMsg?.key?.id;
      if (quizMsgId) {
        quizMessageIds.add(quizMsgId);
        // Bounded eviction: drop oldest entries when the set grows too large.
        if (quizMessageIds.size > MAX_QUIZ_IDS) {
          quizMessageIds.delete(quizMessageIds.values().next().value);
        }
      }

      emitActionAck({
        requestId: rid || requestId,
        action: 'send_quiz',
        ok: true,
        detail: 'sent',
        result: { contextMsgId, messageId: sentMsg?.key?.id || null },
      });
    } catch (err) {
      emitActionError({ requestId: rid || requestId, action: 'send_quiz', err });
    }
    return;
  }

  if (type === 'send_buttons') {
    const sock = getSock();
    const nativeButtons = (payload.buttons || []).map((btn) => ({
      name: btn.name,
      buttonParamsJson: typeof btn.buttonParams === 'object'
        ? JSON.stringify(btn.buttonParams)
        : (btn.buttonParamsJson || '{}'),
    }));
    const result = await sendNativeFlow(sock, payload.chatId, payload.text || '', nativeButtons, { footer: payload.footer });
    emitActionAck({ requestId, action: 'send_buttons', ok: true, detail: 'sent', result });
    return;
  }

  if (type === 'send_carousel') {
    const sock = getSock();
    const cards = (payload.cards || []).map((card) => ({
      ...(card.image ? { image: card.image } : {}),
      ...(card.video ? { video: card.video } : {}),
      body: typeof card.body === 'object' ? (card.body.text || '') : (card.body || ''),
      footer: typeof card.footer === 'object' ? (card.footer.text || '') : (card.footer || ''),
      buttons: (card.buttons || []).map((btn) => ({
        name: btn.name,
        buttonParamsJson: typeof btn.buttonParams === 'object'
          ? JSON.stringify(btn.buttonParams)
          : (btn.buttonParamsJson || '{}'),
      })),
    }));
    const result = await sendCarousel(sock, payload.chatId, cards, { text: payload.text });
    emitActionAck({ requestId, action: 'send_carousel', ok: true, detail: 'sent', result });
    return;
  }

  if (type === 'send_copy_code') {
    const sock = getSock();
    if (!sock) throw new Error('WhatsApp socket not ready');
    const { chatId, code, displayText, quotedPreviewText } = payload;
    // When quotedPreviewText is provided, create a synthetic quoted
    // message with a dummy stanzaId so the CTA Copy bubble shows a
    // reply preview containing the code snippet.  The dummy ID does
    // not correspond to any real message — WhatsApp only renders the
    // quotedMessage content as the preview text.
    let quoted = null;
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
      const result = await withJidQueue(chatId, () =>
        sendCopyCode(sock, chatId, '', code, displayText || 'Copy Code', {
          badge: false,
          ...(quoted ? { quoted } : {}),
        }),
      );
      emitActionAck({ requestId, action: 'send_copy_code', ok: true, detail: 'sent', result });
    } catch (err) {
      emitActionError({ requestId, action: 'send_copy_code', err });
    }
    return;
  }

  if (type && type !== 'hello') {
    wsClient.send({
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

async function bootstrap() {
  if (!config.wsEndpoint) {
    logger.error('Set LLM_WS_ENDPOINT in .env before running.');
    process.exit(1);
  }

  await dbInit();
  await startWhatsApp();

  wsClient.on('message', async (msg) => {
    if (!msg || !msg.type) return;
    try {
      await dispatchCommand(msg);
    } catch (err) {
      const action = msg.type;
      logger.error({ err, action }, 'failed handling ws command');
      emitActionError({
        requestId: msg?.payload?.requestId,
        action,
        err,
      });
    }
  });

  wsClient.connect();
}

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  try {
    await wsClient.close();
  } catch (err) {
    logger.error({ err }, 'ws close failed during shutdown');
  }
  closeAllDbs();
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown(signal).catch((err) => logger.error({ err }, 'shutdown error'));
  });
}

bootstrap().catch((err) => {
  logger.error({ err }, 'bootstrap failed');
  closeAllDbs();
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandledRejection');
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaughtException');
});
