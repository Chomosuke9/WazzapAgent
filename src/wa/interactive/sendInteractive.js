/**
 * sendInteractive.js — NativeFlow-based interactive messages.
 * (quick reply, URL, copy, call, list, combined, raw native flow)
 *
 * interactiveMessage requires two things to render correctly in WhatsApp:
 *   1. Proto content wrapped in viewOnceMessage.message.interactiveMessage
 *      using proto.Message.InteractiveMessage.create() (not fromObject — removed in v7)
 *   2. Binary XML nodes injected into the relay stanza via additionalNodes:
 *      { biz > interactive(type=native_flow) > native_flow(name=mixed,v=9) }
 *      plus a { bot(biz_bot=1) } node for private (non-group) chats
 *
 * sock.sendMessage is NOT used here — it routes through prepareWAMessageMedia
 * which throws "Invalid media type" for interactiveMessage content.
 */
import { proto, generateWAMessageFromContent, isJidGroup } from 'baileys';
import logger from '../../logger.js';

/**
 * Build the additionalNodes array required for interactive messages to render.
 * Groups only need the biz node; private chats also need the bot node.
 *
 * @param {string} jid
 * @returns {Array}
 */
function buildInteractiveNodes(jid, badge = true) {
  const nodes = [
    {
      tag: 'biz',
      attrs: {},
      content: [
        {
          tag: 'interactive',
          attrs: { type: 'native_flow', v: '1' },
          content: [
            { tag: 'native_flow', attrs: { v: '9', name: 'mixed' } },
          ],
        },
      ],
    },
  ];
  if (badge && !isJidGroup(jid)) {
    nodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
  }
  return nodes;
}

/**
 * Internal helper: wrap an interactiveMessage payload and relay it with
 * the required binary XML nodes.
 *
 * @param {object} sock - Baileys socket instance
 * @param {string} jid - Recipient JID
 * @param {object} interactiveContent - proto.Message.InteractiveMessage.create({...}) result
 * @param {object} [quoted] - Optional quoted message
 * @returns {Promise<object>} Generated message object
 */
async function _sendInteractive(sock, jid, interactiveContent, quoted, badge = true, mentions = [], nonJidMentions = 0) {
  const ctxFields = {};
  if (mentions.length > 0) ctxFields.mentionedJid = mentions;
  if (nonJidMentions > 0) ctxFields.nonJidMentions = nonJidMentions;
  if (Object.keys(ctxFields).length > 0) {
    interactiveContent.contextInfo = proto.ContextInfo.create(ctxFields);
  }
  const msg = generateWAMessageFromContent(jid, {
    viewOnceMessage: {
      message: {
        messageContextInfo: {
          deviceListMetadata: {},
          deviceListMetadataVersion: 2,
        },
        interactiveMessage: interactiveContent,
      },
    },
  }, {
    userJid: sock.user.id,
    ...(quoted ? { quoted } : {}),
  });

  logger.debug({ jid, messageId: msg.key.id }, 'relaying interactive message');
  await sock.relayMessage(jid, msg.message, {
    messageId: msg.key.id,
    additionalNodes: buildInteractiveNodes(jid, badge),
  });

  return msg;
}

/**
 * Send quick-reply buttons.
 *
 * @param {object} sock - Baileys socket instance
 * @param {string} jid - Recipient JID
 * @param {string} body - Message body text
 * @param {Array<{id: string, displayText: string}>} buttons - Button definitions
 * @param {{footer?: string, title?: string, quoted?: object}} [options]
 * @returns {Promise<object>}
 * @example
 * await sendQuickReply(sock, jid, 'Pilih menu:', [
 *   { id: 'menu_1', displayText: 'Daftar Produk' },
 *   { id: 'menu_2', displayText: 'Hubungi CS' }
 * ], { title: 'Menu Utama', footer: 'Bot v1' });
 */
async function sendQuickReply(sock, jid, body, buttons, options = {}) {
  const nativeButtons = buttons.map((btn) => ({
    name: 'quick_reply',
    buttonParamsJson: JSON.stringify({ display_text: btn.displayText, id: btn.id }),
  }));
  const mentions = Array.isArray(options.mentions) ? options.mentions : [];
  const nonJidMentions = typeof options.nonJidMentions === 'number' ? options.nonJidMentions : 0;
  return _sendInteractive(sock, jid, proto.Message.InteractiveMessage.create({
    header: proto.Message.InteractiveMessage.Header.create({
      title: options.title || '',
      hasMediaAttachment: false,
    }),
    body: proto.Message.InteractiveMessage.Body.create({ text: body }),
    footer: proto.Message.InteractiveMessage.Footer.create({ text: options.footer || '' }),
    nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
      buttons: nativeButtons,
    }),
  }), options.quoted, true, mentions, nonJidMentions);
}

/**
 * Send CTA URL buttons.
 *
 * @param {object} sock - Baileys socket instance
 * @param {string} jid - Recipient JID
 * @param {string} body - Message body text
 * @param {Array<{displayText: string, url: string, merchantUrl?: string}>} buttons
 * @param {{footer?: string, title?: string, quoted?: object}} [options]
 * @returns {Promise<object>}
 * @example
 * await sendUrlButtons(sock, jid, 'Kunjungi kami:', [
 *   { displayText: 'Website', url: 'https://example.com' }
 * ], { footer: 'Klik untuk buka' });
 */
async function sendUrlButtons(sock, jid, body, buttons, options = {}) {
  const nativeButtons = buttons.map((btn) => ({
    name: 'cta_url',
    buttonParamsJson: JSON.stringify({
      display_text: btn.displayText,
      url: btn.url,
      ...(btn.merchantUrl ? { merchant_url: btn.merchantUrl } : {}),
    }),
  }));
  return _sendInteractive(sock, jid, proto.Message.InteractiveMessage.create({
    header: proto.Message.InteractiveMessage.Header.create({
      title: options.title || '',
      hasMediaAttachment: false,
    }),
    body: proto.Message.InteractiveMessage.Body.create({ text: body }),
    footer: proto.Message.InteractiveMessage.Footer.create({ text: options.footer || '' }),
    nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
      buttons: nativeButtons,
    }),
  }), options.quoted);
}

/**
 * Send a single CTA copy-code button.
 *
 * @param {object} sock - Baileys socket instance
 * @param {string} jid - Recipient JID
 * @param {string} body - Message body text
 * @param {string} copyCode - Text copied to clipboard on tap
 * @param {string} [displayText='Copy Code'] - Button label
 * @param {{footer?: string, quoted?: object}} [options]
 * @returns {Promise<object>}
 * @example
 * await sendCopyCode(sock, jid, 'Kode promo Anda:', 'PROMO2024', 'Salin', {
 *   footer: 'Berlaku 7 hari'
 * });
 */
async function sendCopyCode(sock, jid, body, copyCode, displayText = 'Copy Code', options = {}) {
  return _sendInteractive(sock, jid, proto.Message.InteractiveMessage.create({
    header: proto.Message.InteractiveMessage.Header.create({ hasMediaAttachment: false }),
    body: proto.Message.InteractiveMessage.Body.create({ text: body }),
    footer: proto.Message.InteractiveMessage.Footer.create({ text: options.footer || '' }),
    nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
      buttons: [{
        name: 'cta_copy',
        buttonParamsJson: JSON.stringify({ display_text: displayText, copy_code: copyCode }),
      }],
    }),
  }), options.quoted, options.badge !== false);
}

/**
 * Send a mix of different button types (url, reply, copy, call) in one message.
 *
 * @param {object} sock - Baileys socket instance
 * @param {string} jid - Recipient JID
 * @param {string} body - Message body text
 * @param {Array<
 *   {type: 'url',   displayText: string, url: string} |
 *   {type: 'reply', displayText: string, id: string} |
 *   {type: 'copy',  displayText: string, copyCode: string} |
 *   {type: 'call',  displayText: string, phoneNumber: string}
 * >} buttons
 * @param {{footer?: string, title?: string, quoted?: object}} [options]
 * @returns {Promise<object>}
 * @example
 * await sendCombinedButtons(sock, jid, 'Pilih aksi:', [
 *   { type: 'reply', displayText: 'Konfirmasi', id: 'confirm' },
 *   { type: 'url',   displayText: 'Detail', url: 'https://example.com' },
 *   { type: 'call',  displayText: 'Telepon', phoneNumber: '+6281234567890' }
 * ]);
 */
async function sendCombinedButtons(sock, jid, body, buttons, options = {}) {
  const nativeButtons = buttons.map((btn) => {
    switch (btn.type) {
      case 'url':
        return { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: btn.displayText, url: btn.url }) };
      case 'reply':
        return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: btn.displayText, id: btn.id }) };
      case 'copy':
        return { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: btn.displayText, copy_code: btn.copyCode }) };
      case 'call':
        return { name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text: btn.displayText, phone_number: btn.phoneNumber }) };
      default:
        return { name: btn.type, buttonParamsJson: JSON.stringify({ display_text: btn.displayText }) };
    }
  });
  return _sendInteractive(sock, jid, proto.Message.InteractiveMessage.create({
    header: proto.Message.InteractiveMessage.Header.create({
      title: options.title || '',
      hasMediaAttachment: false,
    }),
    body: proto.Message.InteractiveMessage.Body.create({ text: body }),
    footer: proto.Message.InteractiveMessage.Footer.create({ text: options.footer || '' }),
    nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
      buttons: nativeButtons,
    }),
  }), options.quoted);
}

/**
 * Send a single-select list (dropdown menu).
 * Uses listMessage which is supported directly via sock.sendMessage.
 *
 * @param {object} sock - Baileys socket instance
 * @param {string} jid - Recipient JID
 * @param {{
 *   title: string,
 *   buttonText: string,
 *   sections: Array<{title: string, rows: Array<{rowId: string, title: string, description?: string}>}>,
 *   footer?: string,
 *   description?: string
 * }} content
 * @param {{quoted?: object}} [options]
 * @returns {Promise<object>}
 * @example
 * await sendList(sock, jid, {
 *   title: 'Menu Restoran',
 *   buttonText: 'Lihat Menu',
 *   sections: [{
 *     title: 'Makanan',
 *     rows: [{ rowId: 'nasi_goreng', title: 'Nasi Goreng', description: 'Rp 25.000' }]
 *   }],
 *   footer: 'Order via chat'
 * });
 */
async function sendList(sock, jid, content, options = {}) {
  return sock.sendMessage(jid, {
    text: content.description || content.title || '',
    footer: content.footer || '',
    buttonText: content.buttonText,
    sections: content.sections,
    listType: 1,
  }, { quoted: options.quoted });
}

/**
 * Send a raw NativeFlow interactive message with pre-formatted buttons.
 *
 * @param {object} sock - Baileys socket instance
 * @param {string} jid - Recipient JID
 * @param {string} body - Message body text
 * @param {Array<{name: string, buttonParamsJson: string}>} buttons - Pre-formatted button array
 * @param {{footer?: string, header?: {title?: string, subtitle?: string}, quoted?: object}} [options]
 * @returns {Promise<object>}
 * @example
 * await sendNativeFlow(sock, jid, 'Choose:', [
 *   { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Yes', id: 'yes' }) }
 * ], { footer: 'Tap to select' });
 */
async function sendNativeFlow(sock, jid, body, buttons, options = {}) {
  return _sendInteractive(sock, jid, proto.Message.InteractiveMessage.create({
    header: proto.Message.InteractiveMessage.Header.create({
      title: options.header?.title || '',
      subtitle: options.header?.subtitle || '',
      hasMediaAttachment: false,
    }),
    body: proto.Message.InteractiveMessage.Body.create({ text: body }),
    footer: proto.Message.InteractiveMessage.Footer.create({ text: options.footer || '' }),
    nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({ buttons }),
  }), options.quoted);
}

/**
 * Send a rich styled message using interactiveMessage layout with the AI badge.
 * Works as a drop-in replacement for sock.sendMessage({ text }) whenever you want
 * a header title, subtitle, image, footer, or optional buttons — without having to
 * compose the proto payload manually.
 *
 * Buttons are optional. When omitted the message renders as a styled announcement
 * (header + body + footer) with no interactive elements.
 *
 * @param {object} sock - Baileys socket instance
 * @param {string} jid - Recipient JID
 * @param {{
 *   text: string,
 *   title?: string,
 *   subtitle?: string,
 *   image?: {url: string} | string,
 *   video?: {url: string} | string,
 *   footer?: string,
 *   buttons?: Array<{name: string, buttonParamsJson: string}>,
 *   badge?: boolean,
 *   quoted?: object
 * }} options
 * @returns {Promise<object>}
 * @example
 * // Plain styled text with AI badge (no buttons):
 * await sendRichMessage(sock, jid, { title: '📢 Pengumuman', text: 'Server down 23:00–01:00.' });
 *
 * // With quick reply buttons:
 * await sendRichMessage(sock, jid, {
 *   title: 'Konfirmasi',
 *   text: 'Lanjutkan pesanan?',
 *   footer: 'Tap tombol di bawah',
 *   buttons: [
 *     { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Ya', id: 'yes' }) },
 *     { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Tidak', id: 'no' }) },
 *   ],
 * });
 */
async function sendRichMessage(sock, jid, options = {}) {
  const headerFields = { hasMediaAttachment: false };
  if (options.title) headerFields.title = options.title;
  if (options.subtitle) headerFields.subtitle = options.subtitle;
  if (options.image) {
    headerFields.hasMediaAttachment = true;
    headerFields.imageMessage = { url: options.image?.url ?? options.image };
  } else if (options.video) {
    headerFields.hasMediaAttachment = true;
    headerFields.videoMessage = { url: options.video?.url ?? options.video };
  }

  return _sendInteractive(sock, jid, proto.Message.InteractiveMessage.create({
    header: proto.Message.InteractiveMessage.Header.create(headerFields),
    body: proto.Message.InteractiveMessage.Body.create({ text: options.text || '' }),
    footer: proto.Message.InteractiveMessage.Footer.create({ text: options.footer || '' }),
    nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
      buttons: options.buttons || [],
    }),
  }), options.quoted, options.badge !== false, options.mentions || [], options.nonJidMentions || 0);
}

export {
  _sendInteractive,
  buildInteractiveNodes,
  sendQuickReply,
  sendUrlButtons,
  sendCopyCode,
  sendCombinedButtons,
  sendList,
  sendNativeFlow,
  sendRichMessage,
};
