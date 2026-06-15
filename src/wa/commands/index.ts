// Barrel re-export — command parsing, context type, and dispatch.
// `parseSlashCommand` (canonical resolution) and the typed registry live in
// `commands/`; the raw parser stays in `parseCommand.ts`.
export { parseRawSlash } from './parseCommand.js';
export { parseSlashCommand, getCommand, dispatchCommand } from '../command/CommandRegistry.js';
export type { CommandHandler, CommandContext } from '../command/CommandContext.js';
