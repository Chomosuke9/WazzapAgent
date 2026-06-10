import logger from '../../logger.js';
import { activateChat } from '../../db.js';
import type { CommandContext } from './parseCommand.js';

async function handleActivate({ chatId, chatType, args, sock }: CommandContext): Promise<void> {
  const code = (args || '').trim().toUpperCase();

  if (!code) {
    try {
      await sock.sendMessage(chatId, { text: 'Penggunaan: /activate <kode>' });
    } catch (err) { /* ignore */ }
    return;
  }

  const result = activateChat(chatId, code, chatType as string);

  try {
    await sock.sendMessage(chatId, { text: result.message });
  } catch (err) {
    logger.warn({ err, chatId }, 'failed sending /activate response');
  }
}

export { handleActivate };
