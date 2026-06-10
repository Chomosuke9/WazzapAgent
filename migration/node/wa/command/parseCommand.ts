import type { WAMessage } from 'baileys';
import type { AccountContext } from '../../account/accountContext.js';

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

function parseSlashCommand(text: string | null): { command: string; args: string } | null {
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

// ---------------------------------------------------------------------------
// Shared command-handler context
// ---------------------------------------------------------------------------

// Runtime shape is unchanged — this interface only documents the object the
// command dispatcher passes to each handler. Fields are optional unless a
// handler relies on them being present without a guard. Extra/unknown
// properties are tolerated via the index signature so callers (still JS) and
// future fields do not break type-checking.
export interface CommandContext {
  chatId: string;
  args: string;
  senderId: string;
  chatType?: string;
  text?: string;
  contextMsgId?: string;
  quotedMessageId?: string;
  senderDisplay?: string;
  senderRole?: { isAdmin?: boolean; isSuperAdmin?: boolean } | null;
  senderIsAdmin?: boolean;
  senderIsOwner?: boolean;
  botIsAdmin?: boolean;
  isGroup?: boolean;
  fromMe?: boolean;
  group?: {
    name?: string;
    participants?: unknown[];
    description?: string;
    botIsAdmin?: boolean;
    botIsSuperAdmin?: boolean;
  } | null;
  msg?: WAMessage;
  /**
   * Per-account state holder (Step 16). Present on contexts built by the live
   * dispatcher (connection.ts / runCommand.ts) and consumed by handlers that
   * touch per-account caches/identifiers (e.g. /catch, /sticker, /monitor,
   * /broadcast).
   */
  account?: AccountContext;
  /**
   * The acting account's live Baileys socket (Step 33). Threaded by
   * `commandHandler` / `dispatchRunCommand` from the per-account context so
   * handlers send via `ctx.sock` instead of the removed global socket accessor.
   * Typed loosely (`any`) to match the original untyped accessor.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sock?: any;
  /**
   * Acting account's tenant key (Step 21). Threaded by `commandHandler` so
   * control-emitting handlers route reliable frames to THIS account's Python
   * client via `registry.sendReliableToClient(folderPath, …)`. Falls back to
   * the DEFAULT/live account (`config.dataDir`) on the single-account boot.
   */
  folderPath?: string;
  [key: string]: unknown;
}

export { parseSlashCommand };
