import logger from '../../logger.js';
import { getSock } from '../connection.js';
import { revokeActivationCode } from '../../db.js';

async function handleRevoke({ chatId, args }) {
  const sock = getSock();
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

  const result = revokeActivationCode(id);

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