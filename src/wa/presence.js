import logger from '../logger.js';
import { getSock } from './connection.js';

async function markChatRead({ chatId, messageId, participant }) {
  const sock = getSock();
  if (!sock) return;
  try {
    const key = {
      remoteJid: chatId,
      id: messageId,
    };
    if (participant) key.participant = participant;
    await sock.readMessages([key]);
  } catch (err) {
    logger.warn({ err, chatId, messageId }, 'markChatRead failed');
  }
}

async function sendPresence({ chatId, type }) {
  const sock = getSock();
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
