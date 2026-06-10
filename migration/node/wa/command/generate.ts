import logger from '../../logger.js';
import { generateActivationCode } from '../../db.js';
import type { CommandContext } from './parseCommand.js';

async function handleGenerate({ chatId, senderId, args, sock }: CommandContext): Promise<void> {
  const parts = (args || '').trim().split(/\s+/);

  if (parts.length < 2) {
    try {
      await sock.sendMessage(chatId, {
        text: 'Penggunaan: /generate <private|group|all> <jumlah_hari>/0\n\nContoh:\n/generate private 30\n/generate group 0\n/generate all 7',
      });
    } catch (err) { /* ignore */ }
    return;
  }

  const type = parts[0].toLowerCase();
  const days = parseInt(parts[1], 10);

  const validTypes = new Set(['private', 'group', 'all']);
  if (!validTypes.has(type)) {
    try {
      await sock.sendMessage(chatId, { text: 'Tipe harus: private, group, atau all' });
    } catch (err) { /* ignore */ }
    return;
  }

  if (isNaN(days) || days < 0) {
    try {
      await sock.sendMessage(chatId, { text: 'Jumlah hari harus berupa angka 0 atau lebih. 0 = permanen.' });
    } catch (err) { /* ignore */ }
    return;
  }

  try {
    const result = generateActivationCode(type, days, senderId);
    const typeLabel = type === 'all' ? 'semua (private & grup)' : (type === 'group' ? 'grup' : 'private');
    const durationLabel = days === 0 ? 'Permanen' : `${days} hari`;

    await sock.sendMessage(chatId, {
      text: `Kode aktivasi berhasil dibuat!\nTipe: ${typeLabel}\nMasa aktif: ${durationLabel}\nDibuat oleh: owner`,
    });
    await sock.sendMessage(chatId, { text: result.code });
  } catch (err) {
    logger.error({ err }, 'failed generating activation code');
    try {
      await sock.sendMessage(chatId, { text: 'Gagal membuat kode aktivasi.' });
    } catch (e) { /* ignore */ }
  }
}

export { handleGenerate };
