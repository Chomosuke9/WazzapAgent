import logger from '../../logger.js';
import type { CommandContext, CommandHandler } from '../command/CommandContext.js';

async function handleRevoke({ chatId, args, sock, repos }: CommandContext): Promise<void> {
  const idStr = (args || '').trim();

  if (!idStr) {
    try {
      await sock.sendMessage(chatId, { text: 'Penggunaan: /revoke <id>\n\nGunakan /monitor untuk melihat daftar ID kode aktivasi.' });
    } catch (err) { /* ignore */ }
    return;
  }

  const id = parseInt(idStr, 10);
  if (isNaN(id) || id <= 0) {
    try {
      await sock.sendMessage(chatId, { text: 'ID harus berupa angka positif. Gunakan /monitor untuk melihat daftar ID.' });
    } catch (err) { /* ignore */ }
    return;
  }

  const result = repos!.activation.revokeActivationCode(id);

  try {
    if (result.success) {
      let msg = `Kode aktivasi #${id} berhasil dicabut.`;
      if (result.wasUsed) {
        msg += '\nKode sudah dipakai oleh chat yang sekarang juga kehilangan akses.';
      }
      await sock.sendMessage(chatId, { text: msg });
    } else {
      await sock.sendMessage(chatId, { text: result.message });
    }
  } catch (err) {
    logger.warn({ err, chatId }, 'failed sending /revoke response');
  }
}

export { handleRevoke };

export const revokeCommand: CommandHandler = {
  commands: ["revoke"],
  description: "Cabut link undangan grup saat ini dan buat link baru yang fresh. Berguna ketika link lama bocor atau disebar sembarangan. Opsional: ulangi beberapa kali. Contoh: /revoke 3.",
  permission: "owner",
  run: (_sock, _message, ctx) => handleRevoke(ctx),
};