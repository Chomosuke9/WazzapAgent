import logger from '../../logger.js';
import { resolveQuotedMessage } from '../domain/identifiers.js';
import type { CommandContext, CommandHandler } from '../command/CommandContext.js';

async function handleCatch({ chatId, quotedMessageId, account, sock }: CommandContext): Promise<void> {
  if (!quotedMessageId) {
    try {
      await sock.sendMessage(chatId, { text: 'Reply to the message you want to catch, then type `/catch`.' });
    } catch (err) {
      logger.warn({ err, chatId }, 'failed sending /catch usage hint');
    }
    return;
  }

  let cachedMsg: any = account?.messageCache.get(quotedMessageId);
  if (!cachedMsg && account) {
    cachedMsg = resolveQuotedMessage(account, chatId, quotedMessageId);
  }

  if (!cachedMsg || !cachedMsg.message) {
    try {
      await sock.sendMessage(chatId, { text: 'Message not found in cache. Try replying to a more recent message.' });
    } catch (err) {
      logger.warn({ err, chatId, quotedMessageId }, 'failed sending /catch not-found hint');
    }
    return;
  }

  const payload = JSON.stringify(cachedMsg, null, 2);

  try {
    await sock.sendMessage(chatId, { text: `\`\`\`json\n${payload}\n\`\`\`` });
  } catch (err) {
    logger.warn({ err, chatId, quotedMessageId, length: payload.length }, 'failed sending full /catch payload');
    const truncated = payload.length > 6000 ? `${payload.slice(0, 6000)}\n... (truncated)` : payload;
    try {
      await sock.sendMessage(chatId, { text: `\`\`\`json\n${truncated}\n\`\`\`` });
    } catch (e) {
      try {
        await sock.sendMessage(chatId, { text: 'Failed to send payload: too long or an error occurred.' });
      } catch (e2) {
        logger.warn({ err: e2, chatId }, 'failed sending /catch fallback');
      }
    }
  }
}

export { handleCatch };

export const catchCommand: CommandHandler = {
  commands: ["catch", "catches"],
  description: "Mark a message you reply to so the bot can reprocess it. Useful when the bot needs to re-analyze a specific message without resending it.",
  permission: "public",
  run: (_sock, _message, ctx) => handleCatch(ctx),
};