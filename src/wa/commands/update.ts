import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import logger from '../../logger.js';
import type { CommandContext, CommandHandler } from '../command/CommandContext.js';

const execAsync = promisify(exec);
const PROJECT_ROOT = process.cwd();

async function handleUpdate({ chatId, sock }: CommandContext): Promise<void> {
  const send = async (text: string) => {
    try { await sock.sendMessage(chatId, { text }); } catch { /* ignore */ }
  };

  await send('⏳ Pulling latest changes…');

  try {
    const { stdout } = await execAsync('git pull', {
      cwd: PROJECT_ROOT,
      timeout: 60_000,
    });
    const pullResult = stdout.trim();

    if (pullResult === 'Already up to date.') {
      await send('✅ Already up to date — no restart needed.');
      return;
    }

    await send(`📥 ${pullResult}\n\n🔄 Restarting…`);

    // Give the message time to reach WhatsApp, then exit.
    // start.sh (the process supervisor) detects the exit, gracefully
    // stops the Python bridge, and restarts both processes automatically.
    setTimeout(() => {
      logger.info('Process exit triggered by /update command');
      process.exit(0);
    }, 2_000);
  } catch (err: unknown) {
    const detail =
      (err as { stderr?: string }).stderr?.trim() ||
      (err instanceof Error ? err.message : String(err));
    logger.error({ err }, '/update command failed');
    await send(`❌ Update failed:\n${detail}`);
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
