import logger from '../../logger.js';
import { getSock } from '../connection.js';
import { getAllActivationCodes, getAllActivations } from '../../db.js';
import { getCachedGroupMetadata } from '../../groupContext.js';

function formatDuration(expiresAt) {
  if (!expiresAt) return 'Permanen';
  const now = new Date();
  const expiry = new Date(expiresAt);
  const diffMs = expiry.getTime() - now.getTime();
  if (diffMs <= 0) return 'Kadaluarsa';
  const diffDays = Math.floor(diffMs / 86400000);
  const diffHours = Math.floor((diffMs % 86400000) / 3600000);
  const diffMinutes = Math.floor((diffMs % 3600000) / 60000);
  if (diffDays > 0) return `${diffDays} hari ${diffHours} jam`;
  if (diffHours > 0) return `${diffHours} jam ${diffMinutes} menit`;
  return `${diffMinutes} menit`;
}

function formatDurationShort(expiresAt) {
  if (!expiresAt) return 'Permanen';
  const now = new Date();
  const expiry = new Date(expiresAt);
  const diffMs = expiry.getTime() - now.getTime();
  if (diffMs <= 0) return 'Kadaluarsa';
  const diffDays = Math.floor(diffMs / 86400000);
  const diffHours = Math.floor((diffMs % 86400000) / 3600000);
  if (diffDays > 0) return `${diffDays}h ${diffHours}j`;
  if (diffHours > 0) return `${diffHours}j`;
  return `${Math.floor(diffMs / 60000)}m`;
}

async function getChatName(chatId) {
  const sock = getSock();
  if (chatId.endsWith('@g.us')) {
    const metadata = getCachedGroupMetadata(chatId);
    if (metadata?.name) return metadata.name;
    return chatId;
  }
  return chatId;
}

async function handleMonitor({ chatId }) {
  const sock = getSock();
  try {
    const codes = getAllActivationCodes();
    const activations = getAllActivations();

    const codeLines = [];
    for (const code of codes) {
      const typeLabel = code.type === 'all' ? 'semua' : (code.type === 'group' ? 'grup' : 'private');
      const durationLabel = code.days === 0 ? 'Permanen' : `${code.days} hari`;
      const statusIcon = code.used ? '✓' : '✗';
      let usedInfo = 'Belum dipakai';
      if (code.used && code.usedBy) {
        const name = await getChatName(code.usedBy);
        usedInfo = name;
      } else if (code.used) {
        usedInfo = 'Sudah dipakai';
      }
      codeLines.push(`#${code.id} | ${code.code} | ${typeLabel} | ${durationLabel} | ${statusIcon} ${usedInfo}`);
    }

    const activationLines = [];
    for (const act of activations) {
      const name = await getChatName(act.chatId);
      const remaining = formatDuration(act.expiresAt);
      activationLines.push(`${name} (${act.chatId}) | #${act.code} | Sisa: ${remaining}`);
    }

    const sections = [];
    if (codeLines.length > 0) {
      sections.push('=== Kode Aktivasi ===\n' + codeLines.join('\n'));
    } else {
      sections.push('=== Kode Aktivasi ===\nBelum ada kode aktivasi.');
    }

    if (activationLines.length > 0) {
      sections.push('\n=== Chat Teraktivasi ===\n' + activationLines.join('\n'));
    } else {
      sections.push('\n=== Chat Teraktivasi ===\nBelum ada chat teraktivasi.');
    }

    const text = sections.join('\n');
    await sock.sendMessage(chatId, { text });
  } catch (err) {
    logger.error({ err }, 'failed /monitor');
    try {
      await sock.sendMessage(chatId, { text: 'Gagal memuat data monitor.' });
    } catch (e) { /* ignore */ }
  }
}

export { handleMonitor, formatDuration, formatDurationShort };