import logger from '../../logger.js';
import { sendNativeFlow } from '../interactive/index.js';
import config from '../../config.js';
import * as registry from '../../server/accountRegistry.js';
import type { WASocket } from 'baileys';
import type { CommandContext, CommandHandler } from '../command/CommandContext.js';
import type { ButtonHandler } from '../command/ButtonContext.js';
import type { AccountContext } from '../../account/accountContext.js';

async function handleModelcfg({ chatId, senderId: _senderId, args, folderPath = config.dataDir, sock, repos }: CommandContext): Promise<void> {
  // If args contains |, use | as field separator; otherwise fall back to whitespace
  const rawArgs = (args || '').trim();
  let parts: string[];
  let pipeMode = false;
  if (rawArgs.includes('|')) {
    pipeMode = true;
    parts = rawArgs.split('|').map(p => p.trim()).filter(Boolean);
    // Extract subcommand from first field: "add|kimi-k2.6|..." → subcommand="add", rest starts at index 1
    const firstField = parts[0] || '';
    const firstSpace = firstField.indexOf(' ');
    if (firstSpace > 0) {
      const sub = firstField.slice(0, firstSpace).trim();
      const rest = firstField.slice(firstSpace + 1).trim();
      parts = [sub, rest, ...parts.slice(1)];
    }
  } else {
    parts = rawArgs.split(/\s+/);
  }
  const subcommand = parts[0]?.toLowerCase() || '';
  const subArgs = parts.slice(1);

  if (!subcommand) {
    const modelRows = repos!.model.getAllActiveModels().map((m) => ({
      id: `modelcfg_default:${m.modelId}`,
      title: m.displayName + (m.visionSupport ? ' 👁' : ''),
      description: m.description || (m.visionSupport ? 'Vision support' : ''),
    }));
    
    const allModelRows = repos!.model.getAllModels().map((m) => ({
      id: `modelcfg_remove:${m.modelId}`,
      title: m.displayName + (m.isActive ? '' : ' (inactive)') + (m.visionSupport ? ' 👁' : ''),
      description: m.description || `ID: ${m.modelId}`,
    }));

    const editModelRows = repos!.model.getAllModels().map((m) => ({
      id: `/modelcfg edit ${m.modelId}`,
      title: m.displayName + (m.isActive ? '' : ' (inactive)') + (m.visionSupport ? ' 👁' : ''),
      description: m.description || `ID: ${m.modelId}`,
    }));

    const buttons = [
      {
        name: 'single_select',
        buttonParamsJson: JSON.stringify({
          title: 'Default Model',
          sections: [{
            title: 'Select Default',
            rows: modelRows,
          }],
        }),
      },
      {
        name: 'single_select',
        buttonParamsJson: JSON.stringify({
          title: 'Edit Model',
          sections: [{
            title: 'Select Model to Edit',
            rows: editModelRows,
          }],
        }),
      },
      {
        name: 'single_select',
        buttonParamsJson: JSON.stringify({
          title: 'Remove Model',
          sections: [{
            title: 'Select Model to Remove',
            rows: allModelRows,
          }],
        }),
      },
    ];

    try {
      await sendNativeFlow(sock, chatId, 'Model Configuration', buttons, { footer: 'Bot Owner Only' });
    } catch (err) {
      logger.warn({ err, chatId }, 'failed sending /modelcfg menu');
      try {
        await sock.sendMessage(chatId, { text: 'Failed to show modelcfg menu.' });
      } catch (e) { /* ignore */ }
    }
    return;
  }

  if (subcommand === 'remove_menu') {
    const models = repos!.model.getAllModels();
    if (models.length === 0) {
      try {
        await sock.sendMessage(chatId, { text: 'No models to remove.' });
      } catch (err) { /* ignore */ }
      return;
    }
    const sections = [
      {
        title: 'Select Model to Remove',
        rows: models.map((m) => ({
          title: m.displayName + (m.isActive ? '' : ' (inactive)') + (m.visionSupport ? ' 👁' : ''),
          description: m.description || `ID: ${m.modelId}`,
          id: `modelcfg_remove:${m.modelId}`,
        })),
      },
    ];
    try {
      await sendNativeFlow(sock, chatId, '⚠️ Remove Model', [
        {
          name: 'single_select',
          buttonParamsJson: JSON.stringify({
            title: 'Hapus Model',
            sections,
          }),
        },
      ], { footer: 'Pilih model untuk dihapus' });
    } catch (err) {
      logger.warn({ err, chatId }, 'failed sending /modelcfg remove menu');
      try {
        await sock.sendMessage(chatId, { text: 'Failed to show remove menu.' });
      } catch (e) { /* ignore */ }
    }
    return;
  }

  switch (subcommand) {
    case 'list': {
      const models = repos!.model.getAllModels();
      if (models.length === 0) {
        try {
          await sock.sendMessage(chatId, { text: 'No models configured. Use `/modelcfg` add <model_id> <display_name> [description]' });
        } catch (err) { /* ignore */ }
        return;
      }
      const lines = ['*Daftar Model:*'];
      const defaultModel = repos!.model.getDefaultLlm2Model();
      for (const m of models) {
        const isDefault = defaultModel?.modelId === m.modelId;
        const status = m.isActive ? '✓' : '✗';
        const vision = m.visionSupport ? '👁' : '';
        lines.push(`${status} ${m.displayName} (${m.modelId})${isDefault ? ' [DEFAULT]' : ''}${vision ? ` ${vision}` : ''}`);
        if (m.description) lines.push(`   ${m.description}`);
      }
      try {
        await sock.sendMessage(chatId, { text: lines.join('\n') });
      } catch (err) { /* ignore */ }
      break;
    }

    case 'add': {
      if (subArgs.length < 2) {
        try {
          await sock.sendMessage(chatId, { text: 'Usage:\n`/modelcfg add model_id|display_name|[description]|[vision=true]`\n`/modelcfg add model_id display_name [description] [vision=true]`' });
        } catch (err) { /* ignore */ }
        return;
      }
      let modelId: string, displayName: string, restParts: string[];
      if (pipeMode) {
        // pipe mode: fields are already split by |, subArgs = [model_id, display_name, ...rest]
        modelId = subArgs[0];
        displayName = subArgs[1];
        restParts = subArgs.slice(2);
      } else {
        // space mode: all subArgs are space-split tokens
        modelId = subArgs[0];
        displayName = subArgs[1];
        restParts = subArgs.slice(2);
      }
      let visionSupport = false;
      const descParts: string[] = [];
      for (const part of restParts) {
        const lowerPart = part.toLowerCase();
        if (lowerPart.startsWith('vision=') || lowerPart === 'true' || lowerPart === 'false') {
          if (lowerPart === 'true') visionSupport = true;
          else if (lowerPart === 'false') visionSupport = false;
          else if (lowerPart.startsWith('vision=')) {
            const val = part.split('=')[1].toLowerCase();
            visionSupport = val === 'true' || val === '1' || val === 'yes';
          }
        } else {
          descParts.push(part);
        }
      }
      const description = descParts.join(pipeMode ? ' ' : ' ');
      const success = repos!.model.addModel(modelId, displayName, description, null, visionSupport);
      if (success) {
        registry.sendReliableToClient(folderPath, { type: 'invalidate_default_model', folderPath });
      }
      try {
        await sock.sendMessage(chatId, { text: success ? `Model "${displayName}" added.${visionSupport ? ' (Vision enabled)' : ''}` : `Model "${modelId}" already exists.` });
      } catch (err) { /* ignore */ }
      break;
    }

    case 'edit': {
      if (subArgs.length < 1) {
        try {
          await sock.sendMessage(chatId, { text: 'Usage:\n`/modelcfg edit model_id|name=New Name|desc=New desc|vision=true`\n`/modelcfg edit model_id name=New Name vision=true`' });
        } catch (err) { /* ignore */ }
        return;
      }
      const modelId = subArgs[0];
      const updates: {
        displayName?: string;
        description?: string;
        isActive?: boolean;
        sortOrder?: number;
        visionSupport?: boolean;
      } = {};
      for (let i = 1; i < subArgs.length; i++) {
        const part = subArgs[i];
        const match = part.match(/^(name|desc|active|order|vision)=(.+)$/);
        if (match) {
          const [, key, value] = match;
          if (key === 'name') updates.displayName = value;
          else if (key === 'desc') updates.description = value;
          else if (key === 'active') updates.isActive = value === '1' || value === 'true';
          else if (key === 'order') updates.sortOrder = parseInt(value, 10);
          else if (key === 'vision') updates.visionSupport = value === 'true' || value === '1' || value === 'yes';
        }
      }
      const success = repos!.model.updateModel(modelId, updates);
      if (success) {
        registry.sendReliableToClient(folderPath, { type: 'invalidate_default_model', folderPath });
      }
      try {
        await sock.sendMessage(chatId, { text: success ? `Model "${modelId}" updated.` : `Model "${modelId}" not found.` });
      } catch (err) { /* ignore */ }
      break;
    }

    case 'remove':
    case 'delete': {
      if (subArgs.length < 1) {
        try {
          await sock.sendMessage(chatId, { text: 'Usage: `/modelcfg` remove <model_id>' });
        } catch (err) { /* ignore */ }
        return;
      }
      const [modelId] = subArgs;
      const result = repos!.model.deleteModel(modelId);
      if (result.success) {
        registry.sendReliableToClient(folderPath, { type: 'invalidate_default_model', folderPath });
        for (const affectedChatId of result.affectedChatIds) {
          registry.sendReliableToClient(folderPath, { type: 'set_llm2_model', folderPath, chatId: affectedChatId, modelId: null });
          registry.sendReliableToClient(folderPath, { type: 'clear_history', folderPath, chatId: affectedChatId });
          registry.sendReliableToClient(folderPath, { type: 'invalidate_llm2_model', folderPath, chatId: affectedChatId });
        }
      }
      try {
        await sock.sendMessage(chatId, { text: result.success ? `Model "${modelId}" deleted.` : `Model "${modelId}" not found.` });
      } catch (err) { /* ignore */ }
      break;
    }

    default:
      try {
        await sock.sendMessage(chatId, { text: 'Unknown subcommand. Use: list, add, edit, remove' });
      } catch (err) { /* ignore */ }
  }
}

export { handleModelcfg };

export const modelcfgCommand: CommandHandler = {
  commands: ["modelcfg", "modelcfgs"],
  description: "Konfigurasi model LLM dan parameternya (temperature, max token, dll) untuk chat ini atau secara global. Tanpa argumen menampilkan konfigurasi saat ini. Khusus owner.",
  permission: "isOwner",
  run: (_sock, _message, ctx) => handleModelcfg(ctx),
};

// ---------------------------------------------------------------------------
// Co-located button handler + model-config form machinery
// ---------------------------------------------------------------------------
//
// The `/modelcfg` interactive menu (rendered by `handleModelcfg` above) and its
// follow-up form replies used to live in `wa/connection.ts`. They are now
// co-located here: the button handler is auto-discovered by `ButtonRegistry`
// and the owner gate is declarative (`permission: "owner"`) — enforced centrally
// by `dispatchButton` rather than the old inline `isOwnerJid` check. The pending
// `/modelcfg` form lives on the per-account `ctx.pendingForms` so each account
// keeps independent form state.

// Result of parsing a model-config form reply. Fields beyond `action` are
// populated depending on the form type / validity (mirrors the original
// runtime object).
interface ModelReplyResult {
  action: "edit_model" | "add_model";
  modelId?: string;
  success?: boolean;
  updates?: {
    displayName?: string;
    description?: string;
    isActive?: boolean;
    sortOrder?: number;
    visionSupport?: boolean;
  };
  error?: string;
  displayName?: string;
  description?: string;
  visionSupport?: boolean;
}

function clearPendingForm(ctx: AccountContext, chatId: string): void {
  ctx.pendingForms.delete(chatId);
}

function getPendingForm(ctx: AccountContext, chatId: string) {
  return ctx.pendingForms.get(chatId);
}

function parseModelReply(ctx: AccountContext, chatId: string, text: string): ModelReplyResult | null {
  const form = ctx.pendingForms.get(chatId);
  if (!form) return null;

  const fields = text
    .split("|")
    .map((f) => f.trim())
    .filter(Boolean);

  if (form.type === "edit_model") {
    const modelId = form.modelId;
    clearPendingForm(ctx, chatId);

    const updates: ModelReplyResult["updates"] = {};

    for (const field of fields) {
      const eqIdx = field.indexOf("=");
      if (eqIdx < 1) continue;
      const k = field.slice(0, eqIdx).trim().toLowerCase();
      const v = field.slice(eqIdx + 1).trim();

      if (k === "name") updates.displayName = v;
      else if (k === "desc") updates.description = v;
      else if (k === "active")
        updates.isActive = v === "1" || v === "true" || v === "yes";
      else if (k === "order") {
        const n = parseInt(v, 10);
        if (!isNaN(n)) updates.sortOrder = n;
      } else if (k === "vision")
        updates.visionSupport = v === "true" || v === "1" || v === "yes";
    }

    const success = ctx.repos!.model.updateModel(modelId, updates);
    return { action: "edit_model", modelId, success, updates };
  }

  if (form.type === "add_model") {
    clearPendingForm(ctx, chatId);
    if (fields.length < 2) {
      return {
        action: "add_model",
        error: "Format: model_id|display_name|[description]|[vision=true]",
      };
    }
    const modelId = fields[0];
    const displayName = fields[1];

    // Parse remaining fields: key=value pairs and bare true/false as metadata,
    // everything else as description text
    let visionSupport = false;
    const descParts: string[] = [];
    for (let i = 2; i < fields.length; i++) {
      const field = fields[i];
      const lowerField = field.toLowerCase();
      // Check for key=value pairs (e.g. vision=true)
      const eqIdx = field.indexOf("=");
      if (eqIdx > 0) {
        const k = field.slice(0, eqIdx).trim().toLowerCase();
        const v = field
          .slice(eqIdx + 1)
          .trim()
          .toLowerCase();
        if (k === "vision") {
          visionSupport = v === "true" || v === "1" || v === "yes";
          continue;
        }
      }
      // Check for bare true/false as standalone vision flag
      if (lowerField === "true" || lowerField === "false") {
        visionSupport = lowerField === "true";
        continue;
      }
      // Otherwise it's description text
      descParts.push(field);
    }
    const description = descParts.join(" ");
    return {
      action: "add_model",
      modelId,
      displayName,
      description,
      visionSupport,
    };
  }

  return null;
}

async function showModelSelectionForEdit(sock: WASocket, ctx: AccountContext, chatId: string): Promise<void> {
  const models = ctx.repos!.model.getAllModels();
  if (models.length === 0) {
    await sock.sendMessage(chatId, { text: "No models to edit." });
    return;
  }
  const sections = [
    {
      title: "Select Model to Edit",
      rows: models.map((m) => ({
        id: `/modelcfg edit ${m.modelId}`,
        title:
          m.displayName +
          (m.isActive ? "" : " (inactive)") +
          (m.visionSupport ? " 👁" : ""),
        description: m.description || `ID: ${m.modelId}`,
      })),
    },
  ];
  await sendNativeFlow(
    sock,
    chatId,
    "Edit Model",
    [
      {
        name: "single_select",
        buttonParamsJson: JSON.stringify({ title: "Select Model", sections }),
      },
    ],
    { footer: "Select a model to edit" },
  );
}

async function showModelAddForm(sock: WASocket, ctx: AccountContext, chatId: string, senderId: string): Promise<void> {
  ctx.pendingForms.set(chatId, { type: "add_model", senderId });

  const helpText = `Add New Model

Send using | as separator:
model_id|display_name|description|vision=true

Examples:
gpt-4o|GPT-4 Omni|Fast and capable model|vision=true
kimi-k2.6|Kimi|vision=true
my-model|My Custom Model

Or send "cancel" to cancel.`;

  await sock.sendMessage(chatId, { text: helpText });
}

async function showModelSelectionForDefault(sock: WASocket, ctx: AccountContext, chatId: string): Promise<void> {
  const models = ctx.repos!.model.getAllModels().filter((m) => m.isActive);
  if (models.length === 0) {
    await sock.sendMessage(chatId, {
      text: "No active models to set as default.",
    });
    return;
  }
  const sections = [
    {
      title: "Select Default Model",
      rows: models.map((m) => ({
        id: `/modelcfg default ${m.modelId}`,
        title: m.displayName + (m.visionSupport ? " 👁" : ""),
        description: m.description || `ID: ${m.modelId}`,
      })),
    },
  ];
  await sendNativeFlow(
    sock,
    chatId,
    "Set Default Model",
    [
      {
        name: "single_select",
        buttonParamsJson: JSON.stringify({ title: "Select Default", sections }),
      },
    ],
    { footer: "Model with smallest order will be used as default" },
  );
}

async function setDefaultModel(sock: WASocket, ctx: AccountContext, folderPath: string, chatId: string, modelId: string): Promise<void> {
  const models = ctx.repos!.model.getAllModels();
  const model = models.find((m) => m.modelId === modelId);
  if (!model) {
    await sock.sendMessage(chatId, { text: `Model "${modelId}" not found.` });
    return;
  }
  const allModels = ctx.repos!.model.getAllModels();
  const minOrder = Math.min(...allModels.map((m) => m.sortOrder));
  ctx.repos!.model.updateModel(modelId, { sortOrder: minOrder - 1 });
  registry.sendReliableToClient(folderPath, { type: "invalidate_default_model", folderPath });
  await sock.sendMessage(chatId, {
    text: `Model "${model.displayName}" set as default.`,
  });
}

/** `modelcfg:`/`modelcfg_` admin menu → list/add/edit/default/remove models.
 * Owner-only via the declarative `permission: "owner"` (the old inline
 * `isOwnerJid` check is gone — the registry enforces it centrally). */
export const modelcfgButton: ButtonHandler = {
  prefixes: ["modelcfg:", "modelcfg_"],
  permission: "owner",
  run: async (bc, payload) => {
    const { sock, account, chatId, senderId } = bc;

    // `payload` is the selectedId minus the matched prefix; for `modelcfg:` /
    // `modelcfg_` both forms strip to the same `<action>[:<modelId>]` tail.
    const subcommand = payload;
    const colonIdx = subcommand.indexOf(":");
    const action = colonIdx >= 0 ? subcommand.slice(0, colonIdx) : subcommand;
    const modelId = colonIdx >= 0 ? subcommand.slice(colonIdx + 1) : "";

    if (action === "list") {
      const models = account.repos!.model.getAllModels();
      if (models.length === 0) {
        await sock.sendMessage(chatId, { text: "No models configured." });
        return;
      }
      const lines = ["*Daftar Model:*"];
      const defaultModel = account.repos!.model.getDefaultLlm2Model();
      for (const m of models) {
        const isDefault = defaultModel?.modelId === m.modelId;
        const vision = m.visionSupport ? " 👁" : "";
        lines.push(
          `${isDefault ? "✓" : "○"} ${m.displayName} (${m.modelId})${isDefault ? " [DEFAULT]" : ""}${vision}`,
        );
        if (m.description) lines.push(`   ${m.description}`);
      }
      await sock.sendMessage(chatId, { text: lines.join("\n") });
      return;
    }

    if (action === "add") {
      await showModelAddForm(sock, account, chatId, senderId);
      return;
    }

    if (action === "edit") {
      await showModelSelectionForEdit(sock, account, chatId);
      return;
    }

    if (action === "default") {
      if (modelId) {
        await setDefaultModel(sock, account, account.folderPath, chatId, modelId);
      } else {
        await showModelSelectionForDefault(sock, account, chatId);
      }
      return;
    }

    if (action === "remove") {
      if (modelId) {
        const result = account.repos!.model.deleteModel(modelId);
        if (result.success) {
          registry.sendReliableToClient(account.folderPath, {
            type: "invalidate_default_model",
            folderPath: account.folderPath,
          });
          for (const affectedChatId of result.affectedChatIds) {
            registry.sendReliableToClient(account.folderPath, {
              type: "set_llm2_model",
              folderPath: account.folderPath,
              chatId: affectedChatId,
              modelId: null,
            });
            registry.sendReliableToClient(account.folderPath, {
              type: "clear_history",
              folderPath: account.folderPath,
              chatId: affectedChatId,
            });
            registry.sendReliableToClient(account.folderPath, {
              type: "invalidate_llm2_model",
              folderPath: account.folderPath,
              chatId: affectedChatId,
            });
          }
        }
        const models = account.repos!.model.getAllModels();
        const model = models.find((m) => m.modelId === modelId);
        const displayName = model?.displayName || modelId;
        await sock.sendMessage(chatId, {
          text: result.success
            ? `Model "${displayName}" removed.`
            : `Model "${modelId}" not found.`,
        });
      } else {
        await sock.sendMessage(chatId, {
          text: "Usage: `/modelcfg` remove <model_id>",
        });
      }
      return;
    }
  },
};

/**
 * Handle an in-flight `/modelcfg` form reply from the chat's pending form owner.
 * Returns `true` when the message was consumed by the form (caller should skip
 * normal processing), `false` when it should fall through to slash-command
 * parsing (no pending form, a different sender, or a non-matching reply).
 *
 * Moved here from `baileysFactory.ts` (Step: button-registry refactor) so all
 * `/modelcfg` form machinery is co-located with the command + button handler.
 */
export async function handlePendingModelForm(
  account: AccountContext,
  sock: WASocket,
  folderPath: string,
  chatId: string,
  senderId: string,
  text: string | null | undefined,
): Promise<boolean> {
  const pending = getPendingForm(account, chatId);
  if (!pending || senderId !== pending.senderId) return false;

  const normalizedText = text?.trim().toLowerCase();
  if (normalizedText === "cancel" || normalizedText === "batal") {
    clearPendingForm(account, chatId);
    await sock.sendMessage(chatId, { text: "Operasi dibatalkan." });
    return true;
  }

  const result = parseModelReply(account, chatId, text as string);
  if (!result) return false;

  if (result.action === "edit_model") {
    if (result.success) {
      registry.sendReliableToClient(folderPath, {
        type: "invalidate_default_model",
        folderPath,
      });
    }
    await sock.sendMessage(chatId, {
      text: result.success
        ? `Model "${result.modelId}" diupdate.`
        : `Model "${result.modelId}" tidak ditemukan.`,
    });
  } else if (result.action === "add_model") {
    if (result.error) {
      await sock.sendMessage(chatId, { text: result.error });
    } else {
      const success = account.repos!.model.addModel(
        result.modelId!,
        result.displayName!,
        result.description,
        null,
        result.visionSupport,
      );
      if (success) {
        registry.sendReliableToClient(folderPath, {
          type: "invalidate_default_model",
          folderPath,
        });
      }
      await sock.sendMessage(chatId, {
        text: success
          ? `Model "${result.displayName}" ditambahkan.${result.visionSupport ? " (Vision enabled)" : ""}`
          : `Model "${result.modelId}" sudah ada.`,
      });
    }
  }
  return true;
}