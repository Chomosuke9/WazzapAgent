import logger from '../../logger.js';
import { sendNativeFlow } from '../interactive/index.js';
import config from '../../config.js';
import type { CommandContext, CommandHandler } from '../command/CommandContext.js';
import type { AccountRepositories } from '../../db/repositories/index.js';

function formatActivationInfo(repos: AccountRepositories, chatId: string): string {
  if (!config.requireActivation) return 'Tidak diperlukan';
  const activation = repos.activation.getChatActivation(chatId);
  if (!activation) return 'Tidak aktif';
  if (!activation.expiresAt) return 'Permanen';
  const now = new Date();
  const expiry = new Date(activation.expiresAt);
  if (expiry <= now) return 'Kadaluarsa';
  const diffMs = expiry.getTime() - now.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  const diffHours = Math.floor((diffMs % 86400000) / 3600000);
  if (diffDays > 0) return `${diffDays} hari ${diffHours} jam`;
  if (diffHours > 0) return `${diffHours} jam`;
  return `${Math.floor(diffMs / 60000)} menit`;
}

async function handleSettings({ chatId, senderId: _senderId, args: _args, sock, repos }: CommandContext): Promise<void> {
  const currentModelId = repos!.model.getLlm2Model(chatId);
  const defaultModel = repos!.model.getDefaultLlm2Model();
  const activeModelId = currentModelId || defaultModel?.modelId;
  const activeModelName = (activeModelId ? repos!.model.getAllModels().find((m) => m.modelId === activeModelId)?.displayName : null) || defaultModel?.displayName || 'default';

  const currentPermission = repos!.settings.getPermission(chatId);
  const currentMode = repos!.settings.getMode(chatId);
  const idleTrigger = repos!.settings.getIdleTrigger(chatId);
  const idleLabel = idleTrigger ? (idleTrigger.min === idleTrigger.max ? `${idleTrigger.min} messages` : `${idleTrigger.min}-${idleTrigger.max} messages`) : 'OFF';

  const permissionLabels = ['Forbidden', 'Delete only', 'Delete & mute', 'All moderation'];
  const permissionLabel = permissionLabels[currentPermission] || String(currentPermission);

  const buttons = [
    {
      name: 'single_select',
      buttonParamsJson: JSON.stringify({
        title: 'Change Model',
        sections: [{
          title: 'Select Model',
          rows: repos!.model.getAllActiveModels().map((m) => ({
            id: `model_select:${m.modelId}`,
            title: m.displayName + (m.visionSupport ? ' 👁' : ''),
            description: m.description || (m.visionSupport ? 'Vision support' : ''),
          })),
        }],
      }),
    },
    {
      name: 'single_select',
      buttonParamsJson: JSON.stringify({
        title: 'Set Permission',
        sections: [{
          title: 'Permission Level',
          rows: [
            { id: '/permission 0', title: 'Level 0 - Forbidden', description: 'No moderation' },
            { id: '/permission 1', title: 'Level 1 - Delete', description: 'Can delete' },
            { id: '/permission 2', title: 'Level 2 - Mute', description: 'Delete & mute' },
            { id: '/permission 3', title: 'Level 3 - All', description: 'Delete, mute & kick' },
          ],
        }],
      }),
    },
    {
      name: 'single_select',
      buttonParamsJson: JSON.stringify({
        title: 'Misc',
        sections: [{
          title: 'Misc Options',
          rows: [
            { id: '/prompt', title: 'Get Prompt', description: 'View current prompt' },
            { id: '/reset', title: 'Reset Chat', description: 'Clear bot memory for this chat' },
          ],
        }],
      }),
    },
  ];

  try {
    await sendNativeFlow(sock, chatId, `Chat Settings\n\nCurrent:\n- Mode: ${currentMode}\n- Model: ${activeModelName}\n- Permission: Level ${currentPermission} (${permissionLabel})\n- Idle Trigger: ${idleLabel}\n- Aktivasi: ${formatActivationInfo(repos!, chatId)}`, buttons, { footer: 'Click a button' });
  } catch (err) {
    logger.warn({ err, chatId }, 'failed sending /settings interactive');
    try {
      await sock.sendMessage(chatId, { text: 'Failed to show settings menu.' });
    } catch (e) { /* ignore */ }
  }
}

export { handleSettings };

export const settingCommand: CommandHandler = {
  commands: ["setting", "settings"],
  description: "Buka menu pengaturan interaktif untuk chat ini. Dari sini kamu bisa mengubah mode respon, model LLM, system prompt, permission moderasi, dan pengaturan lainnya tanpa menghafal perintah.",
  permission: "isPrivate or isAdmin or isOwner",
  run: (_sock, _message, ctx) => handleSettings(ctx),
};