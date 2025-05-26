/**
 * @typedef {Object} SendMessageOptions
 * @property {Object} sock - Baileys socket
 * @property {string} target - JID of target
 * @property {string} message - Message
 * @property {Buffer|string} [image] - Image (optional)
 * @property {string[]} [mentions] - Did I just mention someone? (optional)
 * @property {string} [sendAsReply] - Send as reply (optional)
 * @property {Buffer|string} [video] - video (optional)
 */