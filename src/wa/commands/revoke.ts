import logger from '../../logger.js';
import type { CommandContext, CommandHandler } from '../command/CommandContext.js';

async function handleRevoke({ chatId, args, sock, repos }: CommandContext): Promise<void> {
  const idStr = (args || '').trim();

  if (!idStr) {
    try {
      await sock.sendMessage(chatId, { text: 'Usage: /revoke <id>\n\nUse /monitor to see the list of activation code IDs.' });
    } catch (err) { /* ignore */ }
    return;
  }

  const id = parseInt(idStr, 10);
  if (isNaN(id) || id <= 0) {
    try {
      await sock.sendMessage(chatId, { text: 'The ID must be a positive number. Use /monitor to see the list of IDs.' });
    } catch (err) { /* ignore */ }
    return;
  }

  const result = repos!.activation.revokeActivationCode(id);

  try {
    if (result.success) {
      let msg = `Activation code #${id} revoked successfully.`;
      if (result.wasUsed) {
        msg += '\nThe code was already used by a chat, which now loses access too.';
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
  description: "Revoke the current group invite link and generate a fresh one. Useful when the old link has leaked or been shared carelessly. Optional: repeat several times. Example: /revoke 3.",
  permission: "owner",
  run: (_sock, _message, ctx) => handleRevoke(ctx),
};