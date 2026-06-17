/**
 * sendCarousel.js — Carousel / swipeable Cards messages.
 *
 * Carousel is an interactiveMessage with carouselMessage inside.
 * Despite being a distinct proto oneOf variant, the binary stanza still uses
 * the same type=native_flow additionalNodes as all other interactive messages.
 */
import { proto } from 'baileys';
import type { WAMessage } from 'baileys';
import type { WaSocketLike } from '../../protocol/ports.js';
import { _sendInteractive } from './sendInteractive.js';

type NativeButton = { name: string; buttonParamsJson: string };

type CarouselCard = {
  image?: { url: string } | Buffer | string;
  video?: { url: string } | Buffer | string;
  title?: string;
  body?: string | { text?: string };
  footer?: string | { text?: string };
  buttons?: NativeButton[];
};

type CarouselOptions = {
  text?: string;
  title?: string;
  footer?: string;
  quoted?: WAMessage;
  badge?: boolean;
};

/**
 * Send a carousel message with swipeable cards.
 *
 * @example
 * await sendCarousel(sock, jid, [
 *   {
 *     image: { url: 'https://example.com/p1.jpg' },
 *     title: 'Product A',
 *     body: 'Description A',
 *     footer: 'Rp 100.000',
 *     buttons: [{ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Buy', id: 'buy_a' }) }]
 *   }
 * ], { title: 'Featured Products', footer: 'Swipe to see more' });
 */
async function sendCarousel(
  sock: WaSocketLike,
  jid: string,
  cards: CarouselCard[],
  options: CarouselOptions = {},
): Promise<WAMessage> {
  const mappedCards = cards.map((card) => {
    const headerFields: {
      hasMediaAttachment: boolean;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      imageMessage?: { url: any };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      videoMessage?: { url: any };
      title?: string;
    } = { hasMediaAttachment: false };
    if (card.image) {
      headerFields.hasMediaAttachment = true;
      headerFields.imageMessage = { url: (card.image as { url?: string }).url ?? card.image };
    } else if (card.video) {
      headerFields.hasMediaAttachment = true;
      headerFields.videoMessage = { url: (card.video as { url?: string }).url ?? card.video };
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
