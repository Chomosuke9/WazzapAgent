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
} from './domain/identifiers.js';
import { emitBotActionContextEvent } from './events.js';
import type { ErrorCode } from '../protocol/types.js';
import type { AccountContext } from '../account/accountContext.js';

/** Error augmented with a stable CONTRACT.md §2 ErrorCode and optional detail. */
type ActionError = Error & { code: ErrorCode; detail?: string };

function actionError(code: ErrorCode, message: string, detail: string | null = null): ActionError {
  const err = new Error(message) as ActionError;
  err.code = code;
  if (detail) err.detail = detail;
  return err;
}

async function reactToMessage(
  ctx: AccountContext,
  { chatId, contextMsgId, emoji }: { chatId: string; contextMsgId: string; emoji: string },
): Promise<{ contextMsgId: string; emoji: string }> {
  const sock = ctx.sock;
  if (!sock) throw actionError('send_failed', 'WhatsApp socket not ready');
  if (typeof emoji !== 'string' || !emoji.trim()) {
    throw actionError('invalid_target', 'missing or empty emoji');
  }
  const normalizedContextMsgId = normalizeContextMsgId(contextMsgId);
  if (!normalizedContextMsgId) {
    throw actionError('invalid_target', 'invalid contextMsgId');
  }
  const indexed = getIndexedMessageByContextId(ctx, chatId, normalizedContextMsgId);
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
    emitBotActionContextEvent(ctx, {
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
    throw actionError('send_failed', (err as { message?: string })?.message || 'failed to react to message');
  }
}

async function deleteMessageByContextId(
  ctx: AccountContext,
  { chatId, contextMsgId }: { chatId: string; contextMsgId: string },
): Promise<{ contextMsgId: string; messageId: string | null }> {
  const sock = ctx.sock;
  if (!sock) throw actionError('send_failed', 'WhatsApp socket not ready');
  const normalizedContextMsgId = normalizeContextMsgId(contextMsgId);
  if (!normalizedContextMsgId) {
    throw actionError('invalid_target', 'invalid contextMsgId');
  }
  const indexed = getIndexedMessageByContextId(ctx, chatId, normalizedContextMsgId);
  if (!indexed) {
    throw actionError('not_found', 'context message not found');
  }
  if (indexed.chatId !== chatId) {
    throw actionError('invalid_target', 'context message belongs to a different chat');
  }
  try {
    await sock.sendMessage(chatId, { delete: indexed.key });
    emitBotActionContextEvent(ctx, {
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
    throw actionError('send_failed', (err as { message?: string })?.message || 'failed to delete message');
  }
}

export {
  actionError,
  reactToMessage,
  deleteMessageByContextId,
};
