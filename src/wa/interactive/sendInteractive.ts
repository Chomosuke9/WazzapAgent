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
import type { AnyMessageContent, BinaryNode, WAMessage } from 'baileys';
import type { WaSocketLike } from '../../protocol/ports.js';
import logger from '../../logger.js';

type NativeButton = { name: string; buttonParamsJson: string };

type InteractiveContent = ReturnType<typeof proto.Message.InteractiveMessage.create>;

type MediaRef = { url: string } | string;

/**
 * Build the additionalNodes array required for interactive messages to render.
 * Groups only need the biz node; private chats also need the bot node.
 */
function buildInteractiveNodes(jid: string, badge = true): BinaryNode[] {
  const nodes: BinaryNode[] = [
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
 */
async function _sendInteractive(
  sock: WaSocketLike,
  jid: string,
  interactiveContent: InteractiveContent,
  quoted?: WAMessage,
  badge = true,
  mentions: string[] = [],
  nonJidMentions = 0,
): Promise<WAMessage> {
  const ctxFields: { mentionedJid?: string[]; nonJidMentions?: number } = {};
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
    userJid: sock.user!.id,
    ...(quoted ? { quoted } : {}),
  });

  logger.debug({ jid, messageId: msg.key.id }, 'relaying interactive message');
  await sock.relayMessage(jid, msg.message!, {
    messageId: msg.key.id!,
    additionalNodes: buildInteractiveNodes(jid, badge),
  });

  return msg;
}

type QuickReplyOptions = {
  footer?: string;
  title?: string;
  quoted?: WAMessage;
  mentions?: string[];
  nonJidMentions?: number;
};

/**
 * Send quick-reply buttons.
 *
 * @example
 * await sendQuickReply(sock, jid, 'Choose a menu:', [
 *   { id: 'menu_1', displayText: 'Product List' },
 *   { id: 'menu_2', displayText: 'Contact Support' }
 * ], { title: 'Main Menu', footer: 'Bot v1' });
 */
async function sendQuickReply(
  sock: WaSocketLike,
  jid: string,
  body: string,
  buttons: Array<{ id: string; displayText: string }>,
  options: QuickReplyOptions = {},
): Promise<WAMessage> {
  const nativeButtons: NativeButton[] = buttons.map((btn) => ({
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
 * @example
 * await sendUrlButtons(sock, jid, 'Visit us:', [
 *   { displayText: 'Website', url: 'https://example.com' }
 * ], { footer: 'Click to open' });
 */
async function sendUrlButtons(
  sock: WaSocketLike,
  jid: string,
  body: string,
  buttons: Array<{ displayText: string; url: string; merchantUrl?: string }>,
  options: { footer?: string; title?: string; quoted?: WAMessage } = {},
): Promise<WAMessage> {
  const nativeButtons: NativeButton[] = buttons.map((btn) => ({
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
 * @example
 * await sendCopyCode(sock, jid, 'Your promo code:', 'PROMO2024', 'Copy', {
 *   footer: 'Valid for 7 days'
 * });
 */
async function sendCopyCode(
  sock: WaSocketLike,
  jid: string,
  body: string,
  copyCode: string,
  displayText = 'Copy Code',
  options: { footer?: string; quoted?: WAMessage; badge?: boolean } = {},
): Promise<WAMessage> {
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

type CombinedButton =
  | { type: 'url'; displayText: string; url: string }
  | { type: 'reply'; displayText: string; id: string }
  | { type: 'copy'; displayText: string; copyCode: string }
  | { type: 'call'; displayText: string; phoneNumber: string }
  | { type: string; displayText: string; [key: string]: unknown };

/**
 * Send a mix of different button types (url, reply, copy, call) in one message.
 *
 * @example
 * await sendCombinedButtons(sock, jid, 'Choose an action:', [
 *   { type: 'reply', displayText: 'Confirm', id: 'confirm' },
 *   { type: 'url',   displayText: 'Details', url: 'https://example.com' },
 *   { type: 'call',  displayText: 'Call', phoneNumber: '+6281234567890' }
 * ]);
 */
async function sendCombinedButtons(
  sock: WaSocketLike,
  jid: string,
  body: string,
  buttons: CombinedButton[],
  options: { footer?: string; title?: string; quoted?: WAMessage } = {},
): Promise<WAMessage> {
  const nativeButtons: NativeButton[] = buttons.map((btn) => {
    switch (btn.type) {
      case 'url':
        return { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: btn.displayText, url: (btn as { url: string }).url }) };
      case 'reply':
        return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: btn.displayText, id: (btn as { id: string }).id }) };
      case 'copy':
        return { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: btn.displayText, copy_code: (btn as { copyCode: string }).copyCode }) };
      case 'call':
        return { name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text: btn.displayText, phone_number: (btn as { phoneNumber: string }).phoneNumber }) };
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

type ListContent = {
  title: string;
  buttonText: string;
  sections: Array<{ title: string; rows: Array<{ rowId: string; title: string; description?: string }> }>;
  footer?: string;
  description?: string;
};

/**
 * Send a single-select list (dropdown menu).
 * Uses listMessage which is supported directly via sock.sendMessage.
 *
 * @example
 * await sendList(sock, jid, {
 *   title: 'Restaurant Menu',
 *   buttonText: 'View Menu',
 *   sections: [{
 *     title: 'Food',
 *     rows: [{ rowId: 'nasi_goreng', title: 'Fried Rice', description: 'Rp 25.000' }]
 *   }],
 *   footer: 'Order via chat'
 * });
 */
async function sendList(
  sock: WaSocketLike,
  jid: string,
  content: ListContent,
  options: { quoted?: WAMessage } = {},
): Promise<WAMessage | undefined> {
  return sock.sendMessage(jid, {
    text: content.description || content.title || '',
    footer: content.footer || '',
    buttonText: content.buttonText,
    sections: content.sections,
    listType: 1,
  } as unknown as AnyMessageContent, { quoted: options.quoted });
}

/**
 * Send a raw NativeFlow interactive message with pre-formatted buttons.
 *
 * @example
 * await sendNativeFlow(sock, jid, 'Choose:', [
 *   { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Yes', id: 'yes' }) }
 * ], { footer: 'Tap to select' });
 */
async function sendNativeFlow(
  sock: WaSocketLike,
  jid: string,
  body: string,
  buttons: NativeButton[],
  options: { footer?: string; header?: { title?: string; subtitle?: string }; quoted?: WAMessage } = {},
): Promise<WAMessage> {
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

type RichMessageOptions = {
  text?: string;
  title?: string;
  subtitle?: string;
  image?: MediaRef;
  video?: MediaRef;
  footer?: string;
  buttons?: NativeButton[];
  badge?: boolean;
  quoted?: WAMessage;
  mentions?: string[];
  nonJidMentions?: number;
};

/**
 * Send a rich styled message using interactiveMessage layout with the AI badge.
 * Works as a drop-in replacement for sock.sendMessage({ text }) whenever you want
 * a header title, subtitle, image, footer, or optional buttons — without having to
 * compose the proto payload manually.
 *
 * Buttons are optional. When omitted the message renders as a styled announcement
 * (header + body + footer) with no interactive elements.
 *
 * @example
 * // Plain styled text with AI badge (no buttons):
 * await sendRichMessage(sock, jid, { title: '📢 Announcement', text: 'Server down 23:00–01:00.' });
 *
 * // With quick reply buttons:
 * await sendRichMessage(sock, jid, {
 *   title: 'Confirm',
 *   text: 'Continue with the order?',
 *   footer: 'Tap the button below',
 *   buttons: [
 *     { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Yes', id: 'yes' }) },
 *     { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'No', id: 'no' }) },
 *   ],
 * });
 */
async function sendRichMessage(
  sock: WaSocketLike,
  jid: string,
  options: RichMessageOptions = {},
): Promise<WAMessage> {
  const headerFields: {
    hasMediaAttachment: boolean;
    title?: string;
    subtitle?: string;
    imageMessage?: { url: string };
    videoMessage?: { url: string };
  } = { hasMediaAttachment: false };
  if (options.title) headerFields.title = options.title;
  if (options.subtitle) headerFields.subtitle = options.subtitle;
  if (options.image) {
    headerFields.hasMediaAttachment = true;
    headerFields.imageMessage = { url: (options.image as { url?: string }).url ?? String(options.image) };
  } else if (options.video) {
    headerFields.hasMediaAttachment = true;
    headerFields.videoMessage = { url: (options.video as { url?: string }).url ?? String(options.video) };
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
