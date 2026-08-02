import logger from '../../logger.js';
import {
  ProjectUpdateError,
  ProjectUpdateManager,
  scheduleProcessRestart,
} from '../../system/updateManager.js';
import type { CommandContext, CommandHandler } from '../command/CommandContext.js';

const updateManager = new ProjectUpdateManager();

async function handleUpdate({ chatId, sock }: CommandContext): Promise<void> {
  const send = async (text: string) => {
    try { await sock.sendMessage(chatId, { text }); } catch { /* ignore */ }
  };

  await send('⏳ Checking for a safe update…');

  try {
    const result = await updateManager.update(false);
    if (!result.updated) {
      await send(`✅ ${result.status.message}`);
      return;
    }

    await send('📥 Update applied successfully. Restarting…');
    scheduleProcessRestart(2_000);
  } catch (err: unknown) {
    logger.error({ err }, '/update command failed');
    if (err instanceof ProjectUpdateError && err.code === 'compatibility_change') {
      const current = err.status?.current.compatibilityVersion || 'unknown';
      const available = err.status?.available?.compatibilityVersion || 'unknown';
      await send(
        `⚠️ Update blocked: compatibility changes from v${current} to v${available}. `
        + 'Open Control Panel → System → Runtime & updates to review and confirm it.',
      );
      return;
    }
    const detail = err instanceof Error ? err.message : 'Unknown update error.';
    await send(`❌ Update failed: ${detail}`);
  }
}

export { handleUpdate };

export const updateCommand: CommandHandler = {
  commands: ['update'],
  description: 'Pull latest changes and restart the bot',
  permission: 'isOwner',
  isHidden: true,
  run: (_sock, _message, ctx) => handleUpdate(ctx),
};
