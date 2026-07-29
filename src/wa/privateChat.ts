import config from '../config.js';

/**
 * Return true when an inbound chat must be ignored by the bot-wide private
 * chat gate. WhatsApp groups always use the `@g.us` suffix; every other chat
 * address follows the gateway's existing private-chat classification.
 */
export function shouldIgnorePrivateChat(chatId: string): boolean {
  return !config.privateChatEnabled && !chatId.endsWith('@g.us');
}
