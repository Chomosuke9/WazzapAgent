import logger from '../../logger.js';
import { sendCopyCode } from '../interactive/index.js';
import type { CommandContext, CommandHandler } from '../command/CommandContext.js';

async function handleGenerate({ chatId, senderId, args, sock, repos }: CommandContext): Promise<void> {
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

  let code: string;
  try {
    const result = repos!.activation.generateActivationCode(type, days, senderId);
    code = result.code;
  } catch (err) {
    logger.error({ err }, 'failed generating activation code');
    try {
      await sock.sendMessage(chatId, { text: 'Gagal membuat kode aktivasi.' });
    } catch (e) { /* ignore */ }
    return;
  }

  const botName = sock.user?.name?.trim() || 'bot ini';
  const typeLabel = type === 'all' ? 'semua (private & grup)' : (type === 'group' ? 'grup' : 'private');
  const durationLabel = days === 0 ? 'Permanen' : `${days} hari`;
  const activateCommand = `/activate ${code}`;

  const body =
    `*Kode aktivasi berhasil dibuat!*\n` +
    `Tipe: ${typeLabel}\n` +
    `Masa aktif: ${durationLabel}\n\n` +
    `Salin kodenya dengan menekan tombol di bawah, lalu kirim ke grup tempat ${botName} ingin diaktifkan (atau ke chat pribadi ${botName}).`;

  try {
    await sendCopyCode(sock, chatId, body, activateCommand, 'Salin Kode', {
      footer: durationLabel === 'Permanen' ? 'Aktivasi permanen' : `Berlaku ${durationLabel}`,
    });
  } catch (err) {
    logger.warn({ err, chatId }, 'failed sending /generate cta_copy, falling back to text');
    try {
      await sock.sendMessage(chatId, {
        text: `${body}\n\n${activateCommand}`,
      });
    } catch (e) { /* ignore */ }
  }
}

export { handleGenerate };

export const generateCommand: CommandHandler = {
  commands: ["generate"],
  description: "Buat gambar dari prompt teks (khusus owner). Contoh: /generate kucing astronot pakai helm.",
  isHidden: true,
  permission: "owner",
  run: (_sock, _message, ctx) => handleGenerate(ctx),
};
