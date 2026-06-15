import logger from '../../logger.js';
import type { CommandContext, CommandHandler } from '../command/CommandContext.js';

async function handleActivate({ chatId, chatType, args, sock, repos }: CommandContext): Promise<void> {
  const code = (args || '').trim().toUpperCase();

  if (!code) {
    try {
      await sock.sendMessage(chatId, { text: 'Penggunaan: /activate <kode>' });
    } catch (err) { /* ignore */ }
    return;
  }

  const result = repos!.activation.activateChat(chatId, code, chatType as string);

  try {
    await sock.sendMessage(chatId, { text: result.message });
  } catch (err) {
    logger.warn({ err, chatId }, 'failed sending /activate response');
  }
}

export { handleActivate };

export const activateCommand: CommandHandler = {
  commands: ["activate"],
  description: "Aktifkan chat ini menggunakan kode aktivasi yang diberikan oleh owner. Setelah diaktifkan, bot akan merespon pesan di chat ini. Contoh: /activate WA-ABC12345.",
  permission: "public",
  run: (_sock, _message, ctx) => handleActivate(ctx),
};