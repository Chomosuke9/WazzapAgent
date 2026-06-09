// ---------------------------------------------------------------------------
// Slash command parsing
// ---------------------------------------------------------------------------

const SLASH_CMD_RE = /^\/([a-z][a-z0-9_-]*)\b\s*([\s\S]*)/i;

const COMMAND_ALIASES = new Map([
  ['setting', 'setting'],
  ['settings', 'setting'],
  ['broadcast', 'broadcast'],
  ['broadcasts', 'broadcast'],
  ['prompt', 'prompt'],
  ['prompts', 'prompt'],
  ['reset', 'reset'],
  ['resets', 'reset'],
  ['permission', 'permission'],
  ['permissions', 'permission'],
  ['info', 'info'],
  ['infos', 'info'],
  ['mode', 'mode'],
  ['modes', 'mode'],
  ['trigger', 'trigger'],
  ['triggers', 'trigger'],
  ['dashboard', 'dashboard'],
  ['dashboards', 'dashboard'],
  ['help', 'help'],
  ['helps', 'help'],
  ['debug', 'debug'],
  ['debugs', 'debug'],
  ['join', 'join'],
  ['joins', 'join'],
  ['sticker', 'sticker'],
  ['stickers', 'sticker'],
  ['addsticker', 'add-sticker'],
  ['addstickers', 'add-sticker'],
  ['add-sticker', 'add-sticker'],
  ['add-stickers', 'add-sticker'],
  ['remove-sticker', 'remove-sticker'],
  ['remove-stickers', 'remove-sticker'],
  ['removesticker', 'remove-sticker'],
  ['removestickers', 'remove-sticker'],
  ['model', 'model'],
  ['models', 'model'],
  ['modelcfg', 'modelcfg'],
  ['modelcfgs', 'modelcfg'],
  ['group-status', 'group-status'],
  ['gs', 'group-status'],
  ['catch', 'catch'],
  ['catches', 'catch'],
  ['owner-contact', 'owner-contact'],
  ['subagent', 'subagent'],
  ['subagents', 'subagent'],
  ['idle', 'idle'],
  ['announcement', 'announcement'],
  ['announcements', 'announcement'],
  ['dump', 'dump'],
  ['activate', 'activate'],
  ['generate', 'generate'],
  ['monitor', 'monitor'],
  ['revoke', 'revoke'],
]);

function parseSlashCommand(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.trim().match(SLASH_CMD_RE);
  if (!m) return null;
  const rawCommand = m[1].toLowerCase();
  const command = COMMAND_ALIASES.get(rawCommand);
  if (!command) return null;
  return {
    command,
    args: (m[2] || '').trim(),
  };
}

export { parseSlashCommand };
