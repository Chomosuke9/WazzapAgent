import logger from '../../logger.js';
import { isOwnerJid } from '../domain/participants.js';
import type { CommandContext, CommandHandler } from '../command/CommandContext.js';

function truncateText(value: unknown, maxChars = 300): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3))}...`;
}

async function handleInfoCommand({ chatId, senderId, senderDisplay, senderRole, isGroup, group, sock }: CommandContext): Promise<void> {
  const isOwner = isOwnerJid(senderId);
  const roleLabel = isOwner
    ? 'owner'
    : (senderRole?.isSuperAdmin ? 'superadmin' : (senderRole?.isAdmin ? 'admin' : 'member'));
  const lines = [
    'User info:',
    `Name: ${senderDisplay || 'unknown'}`,
    `JID: ${senderId || 'unknown'}`,
    `Role: ${roleLabel}`,
    `Bot owner: ${isOwner ? 'yes' : 'no'}`,
  ];

  if (isGroup) {
    const groupName = group?.name || chatId;
    const memberCount = Array.isArray(group?.participants) ? group!.participants.length : null;
    const description = truncateText(group?.description, 300);
    lines.push('');
    lines.push('Group info:');
    lines.push(`Group name: ${groupName || 'unknown'}`);
    lines.push(`Group ID: ${chatId || 'unknown'}`);
    lines.push(`Member count: ${typeof memberCount === 'number' ? memberCount : 'unknown'}`);
    lines.push(`Bot admin: ${group?.botIsAdmin ? 'yes' : 'no'}`);
    lines.push(`Bot superadmin: ${group?.botIsSuperAdmin ? 'yes' : 'no'}`);
    if (description) lines.push(`Description: ${description}`);
  } else {
    lines.push('');
    lines.push('Chat info:');
    lines.push('Type: private');
    lines.push(`Chat ID: ${chatId || 'unknown'}`);
  }

  try {
    await sock.sendMessage(chatId, { text: lines.join('\n') });
  } catch (err) {
    logger.warn({ err, chatId }, 'failed sending /info response');
  }
}

export { handleInfoCommand };

export const infoCommand: CommandHandler = {
  commands: ["info", "infos"],
  description: "Show full information about the current context: sender name, role (admin/owner/member), chat type (group/private), activation status, and the bot configuration in effect.",
  permission: "public",
  run: (_sock, _message, ctx) => handleInfoCommand(ctx),
};