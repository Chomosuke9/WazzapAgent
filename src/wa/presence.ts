import logger from '../logger.js';
import type { MarkReadPayload, SendPresencePayload } from '../protocol/types.js';
import type { AccountContext } from '../account/accountContext.js';

async function markChatRead(ctx: AccountContext, { chatId, messageId, participant }: MarkReadPayload): Promise<void> {
  const sock = ctx.sock;
  if (!sock) return;
  try {
    const key: { remoteJid: string; id: string; participant?: string } = {
      remoteJid: chatId,
      id: messageId,
    };
    if (participant) key.participant = participant;
    await sock.readMessages([key]);
  } catch (err) {
    logger.warn({ err, chatId, messageId }, 'markChatRead failed');
  }
}

async function sendPresence(ctx: AccountContext, { chatId, type }: SendPresencePayload): Promise<void> {
  const sock = ctx.sock;
  if (!sock) return;
  try {
    // type: 'composing' | 'paused' | 'recording'
    await sock.sendPresenceUpdate(type || 'composing', chatId);
  } catch (err) {
    logger.warn({ err, chatId, type }, 'sendPresence failed');
  }
}

export {
  markChatRead,
  sendPresence,
};
