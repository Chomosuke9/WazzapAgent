/**
 * actions.js — WhatsApp message reactions and deletions.
 *
 * Provides reactToMessage() and deleteMessageByContextId() which map contextMsgId
 * to WhatsApp message keys and send the appropriate action via sock.sendMessage().
 *
 * Both functions emit synthetic action log events via emitBotActionContextEvent()
 * so the Python bridge can record the action in conversation context.
 *
 * Error handling: Throws actionError() with stable code values:
 *   - 'not_found'        — contextMsgId not in index (message expired or from a different chat)
 *   - 'invalid_target'   — missing contextMsgId, emoji, or cross-chat reference
 *   - 'send_failed'      — socket not ready or WhatsApp API error
 */
import logger from '../logger.js';
import {
  normalizeContextMsgId,
  getIndexedMessageByContextId,
} from '../identifiers.js';
import { getSock } from './connection.js';
import { emitBotActionContextEvent } from './events.js';

function actionError(code, message, detail = null) {
  const err = new Error(message);
  err.code = code;
  if (detail) err.detail = detail;
  return err;
}

async function reactToMessage({ chatId, contextMsgId, emoji }) {
  const sock = getSock();
  if (!sock) throw actionError('send_failed', 'WhatsApp socket not ready');
  if (typeof emoji !== 'string' || !emoji.trim()) {
    throw actionError('invalid_target', 'missing or empty emoji');
  }
  const normalizedContextMsgId = normalizeContextMsgId(contextMsgId);
  if (!normalizedContextMsgId) {
    throw actionError('invalid_target', 'invalid contextMsgId');
  }
  const indexed = getIndexedMessageByContextId(chatId, normalizedContextMsgId);
  if (!indexed) {
    throw actionError('not_found', 'context message not found');
  }
  if (indexed.chatId !== chatId) {
    throw actionError('invalid_target', 'context message belongs to a different chat');
  }
  try {
    await sock.sendMessage(chatId, {
      react: {
        text: emoji.trim(),
        key: indexed.key,
      },
    });
    emitBotActionContextEvent({
      chatId,
      action: 'react_message',
      text: `Action log: reacted ${emoji.trim()} to message <${normalizedContextMsgId}>.`,
      result: {
        contextMsgId: normalizedContextMsgId,
        emoji: emoji.trim(),
      },
    });
    return {
      contextMsgId: normalizedContextMsgId,
      emoji: emoji.trim(),
    };
  } catch (err) {
    throw actionError('send_failed', err?.message || 'failed to react to message');
  }
}

async function deleteMessageByContextId({ chatId, contextMsgId }) {
  const sock = getSock();
  if (!sock) throw actionError('send_failed', 'WhatsApp socket not ready');
  const normalizedContextMsgId = normalizeContextMsgId(contextMsgId);
  if (!normalizedContextMsgId) {
    throw actionError('invalid_target', 'invalid contextMsgId');
  }
  const indexed = getIndexedMessageByContextId(chatId, normalizedContextMsgId);
  if (!indexed) {
    throw actionError('not_found', 'context message not found');
  }
  if (indexed.chatId !== chatId) {
    throw actionError('invalid_target', 'context message belongs to a different chat');
  }
  try {
    await sock.sendMessage(chatId, { delete: indexed.key });
    emitBotActionContextEvent({
      chatId,
      action: 'delete_message',
      text: `Action log: deleted message <${normalizedContextMsgId}>.`,
      result: {
        contextMsgId: normalizedContextMsgId,
        messageId: indexed.id || null,
      },
    });
    return {
      contextMsgId: normalizedContextMsgId,
      messageId: indexed.id,
    };
  } catch (err) {
    throw actionError('send_failed', err?.message || 'failed to delete message');
  }
}

export {
  actionError,
  reactToMessage,
  deleteMessageByContextId,
};
