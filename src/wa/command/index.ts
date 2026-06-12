// Barrel re-export — command parsing, context type, and dispatch.
// `parseSlashCommand` (canonical resolution) and the typed registry live in
// `commands/`; the raw parser stays in `parseCommand.ts`.
export { parseRawSlash } from './parseCommand.js';
export { parseSlashCommand, getCommand, dispatchCommand } from '../commands/CommandRegistry.js';
export type { CommandHandler, CommandContext } from '../commands/CommandContext.js';
export { handleBroadcastCommand } from './broadcast.js';
export { handleInfoCommand } from './info.js';
export { handleDebugCommand } from './debug.js';
export { handleJoinCommand } from './join.js';
export { handleHelp } from './help.js';
export { handlePrompt } from './prompt.js';
export { handleReset } from './reset.js';
export { handleSticker } from './sticker.js';
export { handleAddSticker } from './addsticker.js';
export { handleRemoveSticker } from './removesticker.js';
export { handlePermission } from './permission.js';
export { handleMode } from './mode.js';
export { handleTrigger } from './trigger.js';
export { handleDashboard } from './dashboard.js';
export { handleModel } from './model.js';
export { handleModelcfg } from './modelcfg.js';
export { handleSettings } from './setting.js';
export { handleGroupStatus, sendGroupStatus } from './groupStatus.js';
export { handleCatch } from './catch.js';
export { handleOwnerContact } from './ownerContact.js';
export { handleSubagent } from './subagent.js';
export { handleIdle } from './idle.js';
export { handleAnnouncement } from './announcement.js';
export { handleActivate } from './activate.js';
export { handleGenerate } from './generate.js';
export { handleMonitor } from './monitor.js';
export { handleRevoke } from './revoke.js';
