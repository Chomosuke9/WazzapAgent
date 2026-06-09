import logger from '../../logger.js';
import { getSock } from '../connection.js';
import { sendNativeFlow } from '../interactive/index.js';
import { getAllActiveModels, getAllModels, getDefaultLlm2Model, addModel, updateModel, deleteModel } from '../../db.js';
import wsClient from '../../wsClient.js';

async function handleModelcfg({ chatId, senderId, senderIsOwner, args }) {
  const sock = getSock();
  if (!senderIsOwner) {
    try {
      await sock.sendMessage(chatId, { text: 'Only bot owner can use `/modelcfg`.' });
    } catch (err) { /* ignore */ }
    return;
  }

  // If args contains |, use | as field separator; otherwise fall back to whitespace
  const rawArgs = (args || '').trim();
  let parts;
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
    const modelRows = getAllActiveModels().map((m) => ({
      id: `modelcfg_default:${m.modelId}`,
      title: m.displayName + (m.visionSupport ? ' 👁' : ''),
      description: m.description || (m.visionSupport ? 'Vision support' : ''),
    }));
    
    const allModelRows = getAllModels().map((m) => ({
      id: `modelcfg_remove:${m.modelId}`,
      title: m.displayName + (m.isActive ? '' : ' (inactive)') + (m.visionSupport ? ' 👁' : ''),
      description: m.description || `ID: ${m.modelId}`,
    }));

    const editModelRows = getAllModels().map((m) => ({
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
    const models = getAllModels();
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
      const models = getAllModels();
      if (models.length === 0) {
        try {
          await sock.sendMessage(chatId, { text: 'No models configured. Use `/modelcfg` add <model_id> <display_name> [description]' });
        } catch (err) { /* ignore */ }
        return;
      }
      const lines = ['*Daftar Model:*'];
      const defaultModel = getDefaultLlm2Model();
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
      let modelId, displayName, restParts;
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
      const descParts = [];
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
      const success = addModel(modelId, displayName, description, null, visionSupport);
      if (success) {
        wsClient.sendReliable({ type: 'invalidate_default_model' });
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
      const updates = {};
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
      const success = updateModel(modelId, updates);
      if (success) {
        wsClient.sendReliable({ type: 'invalidate_default_model' });
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
      const result = deleteModel(modelId);
      if (result.success) {
        wsClient.sendReliable({ type: 'invalidate_default_model' });
        for (const affectedChatId of result.affectedChatIds) {
          wsClient.sendReliable({ type: 'set_llm2_model', chatId: affectedChatId, modelId: null });
          wsClient.sendReliable({ type: 'clear_history', chatId: affectedChatId });
          wsClient.sendReliable({ type: 'invalidate_llm2_model', chatId: affectedChatId });
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
