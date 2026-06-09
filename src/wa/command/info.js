import logger from '../../logger.js';
import { isOwnerJid } from '../../participants.js';
import { getSock } from '../connection.js';

function truncateText(value, maxChars = 300) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3))}...`;
}

async function handleInfoCommand({ chatId, senderId, senderDisplay, senderRole, isGroup, group }) {
  const sock = getSock();
  const isOwner = isOwnerJid(senderId);
  const roleLabel = isOwner
    ? 'owner'
    : (senderRole?.isSuperAdmin ? 'superadmin' : (senderRole?.isAdmin ? 'admin' : 'member'));
  const lines = [
    'Info pengguna:',
    `Nama: ${senderDisplay || 'unknown'}`,
    `JID: ${senderId || 'unknown'}`,
    `Peran: ${roleLabel}`,
    `Owner bot: ${isOwner ? 'ya' : 'tidak'}`,
  ];

  if (isGroup) {
    const groupName = group?.name || chatId;
    const memberCount = Array.isArray(group?.participants) ? group.participants.length : null;
    const description = truncateText(group?.description, 300);
    lines.push('');
    lines.push('Info grup:');
    lines.push(`Nama grup: ${groupName || 'unknown'}`);
    lines.push(`ID grup: ${chatId || 'unknown'}`);
    lines.push(`Jumlah anggota: ${typeof memberCount === 'number' ? memberCount : 'unknown'}`);
    lines.push(`Bot admin: ${group?.botIsAdmin ? 'ya' : 'tidak'}`);
    lines.push(`Bot superadmin: ${group?.botIsSuperAdmin ? 'ya' : 'tidak'}`);
    if (description) lines.push(`Deskripsi: ${description}`);
  } else {
    lines.push('');
    lines.push('Info chat:');
    lines.push('Tipe: private');
    lines.push(`ID chat: ${chatId || 'unknown'}`);
  }

  try {
    await sock.sendMessage(chatId, { text: lines.join('\n') });
  } catch (err) {
    logger.warn({ err, chatId }, 'failed sending /info response');
  }
}

export { handleInfoCommand };
