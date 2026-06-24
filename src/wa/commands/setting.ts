import logger from '../../logger.js';
import { sendNativeFlow } from '../interactive/index.js';
import { resolveCallerTier, tierAllows } from '../interactive/compat.js';
import config from '../../config.js';
import * as registry from '../../server/accountRegistry.js';
import { VALID_MODES, VALID_COMPAT_MODES } from '../../db/repositories/SettingsRepository.js';
import { isFeatureConfigured, unconfiguredFeatureMessage } from '../featureAvailability.js';
import type { CommandContext, CommandHandler } from '../command/CommandContext.js';
import type { ButtonHandler } from '../command/ButtonContext.js';
import type { AccountRepositories } from '../../db/repositories/index.js';

function formatActivationInfo(repos: AccountRepositories, chatId: string): string {
  if (!config.requireActivation) return 'Not required';
  const activation = repos.activation.getChatActivation(chatId);
  if (!activation) return 'Inactive';
  if (!activation.expiresAt) return 'Permanent';
  const now = new Date();
  const expiry = new Date(activation.expiresAt);
  if (expiry <= now) return 'Expired';
  const diffMs = expiry.getTime() - now.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  const diffHours = Math.floor((diffMs % 86400000) / 3600000);
  if (diffDays > 0) return `${diffDays} days ${diffHours} hours`;
  if (diffHours > 0) return `${diffHours} hours`;
  return `${Math.floor(diffMs / 60000)} minutes`;
}

async function handleSettings({ chatId, sock, repos, msg }: CommandContext): Promise<void> {
  const currentModelId = repos!.model.getLlm2Model(chatId);
  const defaultModel = repos!.model.getDefaultLlm2Model();
  const activeModelId = currentModelId || defaultModel?.modelId;
  const activeModelName = (activeModelId ? repos!.model.getAllModels().find((m) => m.modelId === activeModelId)?.displayName : null) || defaultModel?.displayName || 'default';

  const currentPermission = repos!.settings.getPermission(chatId);
  const currentMode = repos!.settings.getMode(chatId);
  const compatMode = repos!.settings.getCompatibilityMode(chatId);
  const idleTrigger = repos!.settings.getIdleTrigger(chatId);
  const idleLabel = idleTrigger ? (idleTrigger.min === idleTrigger.max ? `${idleTrigger.min} messages` : `${idleTrigger.min}-${idleTrigger.max} messages`) : 'OFF';

  const permissionLabels = ['Forbidden', 'Delete only', 'Delete & mute', 'All moderation'];
  const permissionLabel = permissionLabels[currentPermission] || String(currentPermission);
  const activationInfo = formatActivationInfo(repos!, chatId);
  const summary = `Current:\n- Mode: ${currentMode}\n- Model: ${activeModelName}\n- Permission: Level ${currentPermission} (${permissionLabel})\n- Idle Trigger: ${idleLabel}\n- Compatibility: ${compatMode}\n- Activation: ${activationInfo}`;

  // Device-/setting-aware rendering. The interactive menu below is built
  // entirely from `single_select` (the `list` interactive kind), which only the
  // `full` tier renders. An explicit `safe`/`semi` compatibility_mode forces the
  // plain-text menu; `auto` derives the tier from the CALLER's own message
  // device (see `resolveCallerTier`) so the caller can still read and operate
  // /setting via the matching slash commands.
  const tier = resolveCallerTier(repos!, chatId, msg?.key?.id);
  if (!tierAllows(tier, 'list')) {
    const text = [
      '*Chat Settings*',
      '',
      summary,
      '',
      'Change with a command:',
      '- `/mode` auto | prefix | hybrid',
      '- `/model` <id>  (run `/model` to list)',
      '- `/permission` 0-3',
      '- `/compat` auto | full | semi | safe',
      '- `/prompt` <text>  (view or set the system prompt)',
      '- `/reset`  (clear bot memory for this chat)',
    ].join('\n');
    try {
      await sock.sendMessage(chatId, { text });
    } catch (err) {
      logger.warn({ err, chatId }, 'failed sending /settings text menu');
    }
    return;
  }

  const buttons = [
    {
      name: 'single_select',
      buttonParamsJson: JSON.stringify({
        title: 'Change Mode',
        sections: [{
          title: 'Select Mode',
          rows: [
            { id: 'mode_select:auto', title: 'Auto', description: 'LLM decides when to respond' },
            { id: 'mode_select:prefix', title: 'Prefix', description: 'Only responds when triggered' },
            { id: 'mode_select:hybrid', title: 'Hybrid', description: 'Prefix first, fallback to auto' },
          ],
        }],
      }),
    },
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
        title: 'Compatibility',
        sections: [{
          title: 'Interactive Compatibility',
          rows: [
            { id: 'compat_select:auto', title: 'Auto', description: 'Match the chat device automatically' },
            { id: 'compat_select:full', title: 'Full', description: 'All interactive (Android)' },
            { id: 'compat_select:semi', title: 'Semi', description: 'No list menus (iOS)' },
            { id: 'compat_select:safe', title: 'Safe', description: 'Plain text only (web/desktop)' },
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
    await sendNativeFlow(sock, chatId, `Chat Settings\n\n${summary}`, buttons, { footer: 'Click a button' });
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
  description: "Open the interactive settings menu for this chat. From here you can change the response mode, LLM model, system prompt, moderation permission, and other settings without memorizing commands.",
  permission: "isPrivate or isAdmin or isOwner",
  run: (_sock, _message, ctx) => handleSettings(ctx),
};

// ---------------------------------------------------------------------------
// Co-located button handlers (auto-discovered by ButtonRegistry)
// ---------------------------------------------------------------------------
//
// These render / act on the menus produced by `handleSettings` above. The
// activation gate and the owner/admin gate are NO LONGER inlined here — they
// are declared via `permission` / the registry default and enforced centrally
// by `dispatchButton`. `payload` is the `selectedId` minus the matched prefix.

/** `settings:<action>` → settings menu (model picker / prompt / permission hints). */
export const settingsButton: ButtonHandler = {
  prefixes: ['settings:'],
  permission: 'owner or (isGroup and isAdmin)',
  run: async (bc, action) => {
    const { sock, account, chatId, msg } = bc;
    if (action === 'model') {
      const models = account.repos!.model.getAllActiveModels();
      if (models.length === 0) {
        await sock.sendMessage(chatId, { text: 'No models available.' });
        return;
      }
      const currentModelId = account.repos!.model.getLlm2Model(chatId);
      const defaultModel = account.repos!.model.getDefaultLlm2Model();
      const activeModelId = currentModelId || defaultModel?.modelId || null;
      // Respect the chat's compatibility mode: the picker is a single_select
      // (`list`) menu, so on `safe`/`semi` (or a non-`full` caller in `auto`)
      // fall back to a text list the caller switches with `/model <id>`.
      if (!tierAllows(resolveCallerTier(account.repos, chatId, msg?.key?.id), 'list')) {
        const lines = models.map(
          (m) => `- \`${m.modelId}\`${m.modelId === activeModelId ? ' ✓' : ''} — ${m.displayName}${m.visionSupport ? ' 👁' : ''}`,
        );
        await sock.sendMessage(chatId, {
          text: ['*Select LLM Model*', '', ...lines, '', 'Switch with `/model <id>`.'].join('\n'),
        });
        return;
      }
      const sections = models.map((m) => ({
        title: m.displayName + (m.visionSupport ? ' 👁' : ''),
        rows: [
          {
            title: m.displayName + (m.modelId === activeModelId ? ' ✓' : ''),
            description: m.description || (m.visionSupport ? 'Vision support' : ''),
            id: `model_select:${m.modelId}`,
          },
        ],
      }));
      await sendNativeFlow(
        sock,
        chatId,
        'Select LLM Model',
        [
          {
            name: 'single_select',
            buttonParamsJson: JSON.stringify({ title: 'Select Model', sections }),
          },
        ],
        { footer: 'Current model: ' + (activeModelId || 'default') },
      );
      return;
    }
    if (action === 'prompt') {
      await sock.sendMessage(chatId, {
        text: 'Use `/prompt` <text> to change the prompt.',
      });
      return;
    }
    if (action === 'permission') {
      await sock.sendMessage(chatId, {
        text: 'Use `/permission` <0-3> to change the level.',
      });
      return;
    }
  },
};

/** `compat_select:<mode>` → set the chat's interactive compatibility mode (the
 * Compatibility section of `/setting` routes here). Node-only setting, so no
 * Python `invalidate_chat_settings` broadcast is needed. */
export const compatSelectButton: ButtonHandler = {
  prefixes: ['compat_select:'],
  permission: 'owner or isPrivate or (isGroup and isAdmin)',
  run: async (bc, mode) => {
    const { sock, account, chatId } = bc;
    if (!VALID_COMPAT_MODES.has(mode)) {
      await sock.sendMessage(chatId, {
        text: 'Invalid compatibility mode. Choose auto, full, semi, or safe.',
      });
      return;
    }
    account.repos!.settings.setCompatibilityMode(chatId, mode);
    await sock.sendMessage(chatId, { text: `Compatibility mode changed to: *${mode}*` });
  },
};

/** `mode_select:<mode>` → set the chat's response mode (replaces the removed
 * `/mode` command; the mode-setting section of `/setting` routes here). */
export const modeSelectButton: ButtonHandler = {
  prefixes: ['mode_select:'],
  permission: 'owner or (isGroup and isAdmin)',
  run: async (bc, mode) => {
    const { sock, account, chatId } = bc;
    if (!VALID_MODES.has(mode)) {
      await sock.sendMessage(chatId, {
        text: 'Invalid mode. Choose auto, prefix, or hybrid.',
      });
      return;
    }
    // Auto/Hybrid modes route messages through the LLM1 router. If LLM1 is not
    // configured, refuse the change with a helpful error so the owner knows
    // their setup is incomplete (prefix mode needs no router and is allowed).
    if (mode !== 'prefix' && !isFeatureConfigured('llm1')) {
      await sock.sendMessage(chatId, { text: unconfiguredFeatureMessage('llm1') });
      return;
    }
    account.repos!.settings.setMode(chatId, mode);
    registry.sendReliableToClient(account.folderPath, {
      type: 'invalidate_chat_settings',
      folderPath: account.folderPath,
      chatId,
    });
    await sock.sendMessage(chatId, { text: `Mode changed to: *${mode}*` });
  },
};

/** `model_select:<id>` → set the chat's LLM2 model. */
export const modelSelectButton: ButtonHandler = {
  prefixes: ['model_select:'],
  permission: 'owner or (isGroup and isAdmin)',
  run: async (bc, modelId) => {
    const { sock, account, chatId } = bc;
    account.repos!.model.setLlm2Model(chatId, modelId);
    registry.sendReliableToClient(account.folderPath, {
      type: 'set_llm2_model',
      folderPath: account.folderPath,
      chatId,
      modelId,
    });
    registry.sendReliableToClient(account.folderPath, {
      type: 'invalidate_llm2_model',
      folderPath: account.folderPath,
      chatId,
    });
    const models = account.repos!.model.getAllActiveModels();
    const model = models.find((m) => m.modelId === modelId);
    const displayName = model?.displayName || modelId;
    const visionNote = model?.visionSupport ? ' (Vision)' : '';
    await sock.sendMessage(chatId, {
      text: `Model changed to: ${displayName}${visionNote}`,
    });
  },
};