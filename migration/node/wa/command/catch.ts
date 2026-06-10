import logger from '../../logger.js';
import { resolveQuotedMessage } from '../../identifiers.js';
import type { CommandContext } from './parseCommand.js';

async function handleCatch({ chatId, quotedMessageId, account, sock }: CommandContext): Promise<void> {
  if (!quotedMessageId) {
    try {
      await sock.sendMessage(chatId, { text: 'Balas ke pesan yang ingin di-catch, lalu ketik `/catch`.' });
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
      await sock.sendMessage(chatId, { text: 'Pesan tidak ditemukan di cache. Coba balas ke pesan yang lebih baru.' });
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
        await sock.sendMessage(chatId, { text: 'Gagal mengirim payload: terlalu panjang atau terjadi kesalahan.' });
      } catch (e2) {
        logger.warn({ err: e2, chatId }, 'failed sending /catch fallback');
      }
    }
  }
}

export { handleCatch };
