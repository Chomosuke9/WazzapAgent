import logger from '../../logger.js';
import { getDevice } from 'baileys';
import { isOwnerJid } from '../domain/participants.js';
import { isActivationRequired } from '../botConfig.js';
import type { CommandContext, CommandHandler } from '../command/CommandContext.js';

/** Human-readable label for a Baileys-detected device class (getDevice). */
const DEVICE_LABELS: Record<string, string> = {
  android: 'Android',
  ios: 'iOS',
  web: 'Web',
  desktop: 'Desktop',
  unknown: 'Unknown',
};

/** Short moderation-permission descriptions (mirrors /permission). */
const PERMISSION_LABELS: Record<number, string> = {
  0: '0 (no moderation)',
  1: '1 (delete)',
  2: '2 (delete & mute)',
  3: '3 (delete, mute & kick)',
};

/**
 * Format a whole-second duration as a compact `Nd Nh Nm Ns` string, omitting
 * leading zero units (e.g. 7200 -> "2h", 0 -> "0s").
 */
function formatUptime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(' ');
}

async function handleInfoCommand({ chatId, senderId, senderDisplay, senderRole, isGroup, group, msg, sock, repos }: CommandContext): Promise<void> {
  const isOwner = isOwnerJid(senderId);
  const roleLabel = isOwner
    ? 'owner'
    : (senderRole?.isSuperAdmin ? 'superadmin' : (senderRole?.isAdmin ? 'admin' : 'member'));
  const device = DEVICE_LABELS[getDevice(msg?.key?.id || '')] || 'Unknown';
  const lines = [
    'User info:',
    `Name: ${senderDisplay || 'unknown'}`,
    `JID: ${senderId || 'unknown'}`,
    `Role: ${roleLabel}`,
    `Device: ${device}`,
    `Bot owner: ${isOwner ? 'yes' : 'no'}`,
  ];

  if (isGroup) {
    const groupName = group?.name || chatId;
    const memberCount = Array.isArray(group?.participants) ? group!.participants.length : null;
    lines.push('');
    lines.push('Group info:');
    lines.push(`Group name: ${groupName || 'unknown'}`);
    lines.push(`Group ID: ${chatId || 'unknown'}`);
    lines.push(`Member count: ${typeof memberCount === 'number' ? memberCount : 'unknown'}`);
    lines.push(`Bot admin: ${group?.botIsAdmin ? 'yes' : 'no'}`);
    lines.push(`Bot superadmin: ${group?.botIsSuperAdmin ? 'yes' : 'no'}`);
    if (repos) {
      const permission = repos.settings.getPermission(chatId);
      lines.push(`Mode: ${repos.settings.getMode(chatId)}`);
      lines.push(`Permission: ${PERMISSION_LABELS[permission] || String(permission)}`);
    }
  } else {
    lines.push('');
    lines.push('Chat info:');
    lines.push('Type: private');
    lines.push(`Chat ID: ${chatId || 'unknown'}`);
  }

  // Bot status — applies to every chat.
  lines.push('');
  lines.push('Bot status:');
  lines.push(`Uptime: ${formatUptime(process.uptime())}`);
  if (isActivationRequired(repos)) {
    const activated = repos?.activation.isChatActivated(chatId) ?? false;
    lines.push(`Activation: required (${activated ? 'activated' : 'not activated'})`);
  } else {
    lines.push('Activation: not required');
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
  description: "Show information about the current context: sender name, role, device, and bot-owner status; group/chat details; the bot configuration in effect (mode and moderation permission); plus bot uptime and activation status.",
  permission: "public",
  run: (_sock, _message, ctx) => handleInfoCommand(ctx),
};