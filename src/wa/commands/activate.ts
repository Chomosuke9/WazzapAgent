import logger from '../../logger.js';
import type { CommandContext, CommandHandler } from '../command/CommandContext.js';

async function handleActivate({ chatId, chatType, args, sock, repos }: CommandContext): Promise<void> {
  const code = (args || '').trim().toUpperCase();

  if (!code) {
    // In private chats, never send any message when not activated (ban risk).
    if (chatType !== 'private') {
      try {
        await sock.sendMessage(chatId, { text: 'Usage: /activate <code>' });
      } catch (err) { /* ignore */ }
    }
    return;
  }

  const result = repos!.activation.activateChat(chatId, code, chatType as string);

  // In private chats, suppress error messages (used/invalid code) to avoid
  // ban risk. Only send success or non-private messages.
  if (chatType !== 'private' || result.success) {
    try {
      await sock.sendMessage(chatId, { text: result.message });
    } catch (err) {
      logger.warn({ err, chatId }, 'failed sending /activate response');
    }
  }
}

export { handleActivate };

export const activateCommand: CommandHandler = {
  commands: ["activate"],
  description: "Activate this chat using the activation code provided by the owner. Once activated, the bot will respond to messages in this chat. Example: /activate WA-ABC12345.",
  permission: "public",
  run: (_sock, _message, ctx) => handleActivate(ctx),
};