/**
 * sendCarousel.js — Carousel / swipeable Cards messages.
 *
 * Carousel is an interactiveMessage with carouselMessage inside.
 * Despite being a distinct proto oneOf variant, the binary stanza still uses
 * the same type=native_flow additionalNodes as all other interactive messages.
 */
import { proto } from 'baileys';
import { _sendInteractive } from './sendInteractive.js';

/**
 * Send a carousel message with swipeable cards.
 *
 * @param {object} sock - Baileys socket instance
 * @param {string} jid - Recipient JID
 * @param {Array<{
 *   image?: {url: string} | Buffer,
 *   video?: {url: string} | Buffer,
 *   title?: string,
 *   body?: string,
 *   footer?: string,
 *   buttons?: Array<{name: string, buttonParamsJson: string}>
 * }>} cards - Carousel card definitions
 * @param {{text?: string, title?: string, footer?: string, quoted?: object}} [options]
 * @returns {Promise<object>}
 * @example
 * await sendCarousel(sock, jid, [
 *   {
 *     image: { url: 'https://example.com/p1.jpg' },
 *     title: 'Produk A',
 *     body: 'Deskripsi A',
 *     footer: 'Rp 100.000',
 *     buttons: [{ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Beli', id: 'buy_a' }) }]
 *   }
 * ], { title: 'Produk Unggulan', footer: 'Swipe untuk lihat lebih' });
 */
async function sendCarousel(sock, jid, cards, options = {}) {
  const mappedCards = cards.map((card) => {
    const headerFields = { hasMediaAttachment: false };
    if (card.image) {
      headerFields.hasMediaAttachment = true;
      headerFields.imageMessage = { url: card.image.url ?? card.image };
    } else if (card.video) {
      headerFields.hasMediaAttachment = true;
      headerFields.videoMessage = { url: card.video.url ?? card.video };
    }
    if (card.title) headerFields.title = card.title;

    return proto.Message.InteractiveMessage.create({
      header: proto.Message.InteractiveMessage.Header.create(headerFields),
      body: proto.Message.InteractiveMessage.Body.create({
        text: typeof card.body === 'string' ? card.body : (card.body?.text || ''),
      }),
      footer: proto.Message.InteractiveMessage.Footer.create({
        text: typeof card.footer === 'string' ? card.footer : (card.footer?.text || ''),
      }),
      nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
        buttons: card.buttons || [],
      }),
    });
  });

  return _sendInteractive(sock, jid, proto.Message.InteractiveMessage.create({
    header: proto.Message.InteractiveMessage.Header.create({
      title: options.title || '',
      hasMediaAttachment: false,
    }),
    body: proto.Message.InteractiveMessage.Body.create({ text: options.text || '' }),
    ...(options.footer ? {
      footer: proto.Message.InteractiveMessage.Footer.create({ text: options.footer }),
    } : {}),
    carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.create({
      cards: mappedCards,
      messageVersion: 1,
    }),
  }), options.quoted, options.badge !== false);
}

export { sendCarousel };
