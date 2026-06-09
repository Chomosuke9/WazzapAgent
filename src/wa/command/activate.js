import logger from '../../logger.js';
import { getSock } from '../connection.js';
import { activateChat } from '../../db.js';

async function handleActivate({ chatId, chatType, args }) {
  const sock = getSock();
  const code = (args || '').trim().toUpperCase();

  if (!code) {
    try {
      await sock.sendMessage(chatId, { text: 'Penggunaan: /activate <kode>' });
    } catch (err) { /* ignore */ }
    return;
  }

  const result = activateChat(chatId, code, chatType);

  try {
    await sock.sendMessage(chatId, { text: result.message });
  } catch (err) {
    logger.warn({ err, chatId }, 'failed sending /activate response');
  }
}

export { handleActivate };