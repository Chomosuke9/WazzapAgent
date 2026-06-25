import logger from '../../logger.js';
import type { WaSocketLike } from '../../protocol/ports.js';
import { sendNativeFlow, sendCarousel, sendRichMessage } from '../interactive/index.js';
import { sendList, sendCombinedButtons } from '../interactive/sendInteractive.js';
import type { CommandContext, CommandHandler } from '../command/CommandContext.js';

// ---------------------------------------------------------------------------
// /debug command
// ---------------------------------------------------------------------------

const DEBUG_TYPES = ['buttons', 'menu', 'list', 'rich', 'combined', 'broadcast', 'carousel', 'carousel-img', 'all'];

async function sendDebugButtons(sock: WaSocketLike, chatId: string): Promise<void> {
  // quick_reply × 3
  await sendNativeFlow(sock, chatId, '[DEBUG] quick_reply buttons', [
    { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Option A', id: 'debug_qr_a' }) },
    { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Option B', id: 'debug_qr_b' }) },
    { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Option C', id: 'debug_qr_c' }) },
  ], { footer: 'Tap any button to test' });

  // cta_url
  await sendNativeFlow(sock, chatId, '[DEBUG] cta_url button', [
    {
      name: 'cta_url',
      buttonParamsJson: JSON.stringify({
        display_text: 'Open Link',
        url: 'https://github.com/chomosuke9/wazzapagents',
        merchant_url: 'https://github.com/chomosuke9/wazzapagents',
      }),
    },
  ], { footer: 'Opens a URL' });

  // cta_copy
  await sendNativeFlow(sock, chatId, '[DEBUG] cta_copy button', [
    {
      name: 'cta_copy',
      buttonParamsJson: JSON.stringify({ display_text: 'Copy Code', id: 'debug_copy', copy_code: 'DEBUG-CODE-123' }),
    },
  ], { footer: 'Tap to copy code to clipboard' });

  // cta_call
  await sendNativeFlow(sock, chatId, '[DEBUG] cta_call button', [
    {
      name: 'cta_call',
      buttonParamsJson: JSON.stringify({ display_text: 'Call Now', id: 'debug_call', phone_number: '+621234567890' }),
    },
  ], { footer: 'Tap to call' });
}

async function sendDebugMenu(sock: WaSocketLike, chatId: string): Promise<void> {
  await sendNativeFlow(sock, chatId, '[DEBUG] single_select (menu/dropdown)', [
    {
      name: 'single_select',
      buttonParamsJson: JSON.stringify({
        title: 'Choose an option',
        sections: [
          {
            title: 'Category 1',
            rows: [
              { title: 'Item A', description: 'Description of item A', id: 'debug_menu_a' },
              { title: 'Item B', description: 'Description of item B', id: 'debug_menu_b' },
            ],
          },
          {
            title: 'Category 2',
            rows: [
              { title: 'Item C', id: 'debug_menu_c' },
              { title: 'Item D', id: 'debug_menu_d' },
            ],
          },
        ],
      }),
    },
  ], { footer: 'Tap to open dropdown menu' });
}

async function sendDebugList(sock: WaSocketLike, chatId: string): Promise<void> {
  await sendList(sock, chatId, {
    title: '[DEBUG] List Message',
    description: 'Tap the button to open the list of choices',
    buttonText: 'Open List',
    footer: 'Pick one of the items',
    sections: [
      {
        title: 'Category A',
        rows: [
          { rowId: 'debug_list_a1', title: 'Item A1', description: 'Description of item A1' },
          { rowId: 'debug_list_a2', title: 'Item A2', description: 'Description of item A2' },
        ],
      },
      {
        title: 'Category B',
        rows: [
          { rowId: 'debug_list_b1', title: 'Item B1' },
          { rowId: 'debug_list_b2', title: 'Item B2' },
        ],
      },
    ],
  });
}

async function sendDebugRichMessage(sock: WaSocketLike, chatId: string): Promise<void> {
  // Styled text without buttons
  await sendRichMessage(sock, chatId, {
    title: '[DEBUG] Rich Message',
    subtitle: 'Subtitle text',
    text: 'Styled message without buttons. Header + body + footer with AI badge (private) or without badge (group).',
    footer: 'Footer text',
  });
  // Styled text with buttons
  await sendRichMessage(sock, chatId, {
    title: '[DEBUG] Rich Message + Buttons',
    text: 'Styled message with quick_reply buttons.',
    footer: 'Tap a button below',
    buttons: [
      { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Choice A', id: 'debug_rich_a' }) },
      { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Choice B', id: 'debug_rich_b' }) },
    ],
  });
}

async function sendDebugCombined(sock: WaSocketLike, chatId: string): Promise<void> {
  await sendCombinedButtons(sock, chatId, '[DEBUG] all button types in one message', [
    { type: 'reply', displayText: 'Quick Reply', id: 'debug_comb_reply' },
    { type: 'url', displayText: 'Open URL', url: 'https://github.com/chomosuke9/wazzapagents' },
    { type: 'copy', displayText: 'Copy Code', copyCode: 'COMBINED-123' },
    { type: 'call', displayText: 'Call', phoneNumber: '+621234567890' },
  ], { title: '[DEBUG] Combined Buttons', footer: 'url + reply + copy + call' });
}

async function sendDebugBroadcast(sock: WaSocketLike, chatId: string): Promise<void> {
  await sendRichMessage(sock, chatId, {
    text: 'This is a sample broadcast message.\n\nThis message is usually sent to all groups the bot is in.',
    footer: 'Broadcast 📢',
    badge: false,
  });
}

async function sendDebugCarousel(sock: WaSocketLike, chatId: string): Promise<void> {
  await sendCarousel(sock, chatId, [
    {
      body: 'Card 1 — quick_reply buttons',
      footer: 'Card 1 footer',
      buttons: [
        { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Pick This', id: 'debug_c1_qr' }) },
        {
          name: 'cta_url',
          buttonParamsJson: JSON.stringify({
            display_text: 'Open Link',
            url: 'https://github.com/chomosuke9/wazzapagents',
            merchant_url: 'https://github.com/chomosuke9/wazzapagents',
          }),
        },
      ],
    },
    {
      body: 'Card 2 — cta_copy & cta_call',
      footer: 'Card 2 footer',
      buttons: [
        { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: 'Copy Code', id: 'debug_c2_copy', copy_code: 'CAROUSEL-456' }) },
        { name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text: 'Call', id: 'debug_c2_call', phone_number: '+621234567890' }) },
      ],
    },
    {
      body: 'Card 3 — single_select',
      footer: 'Card 3 footer',
      buttons: [
        {
          name: 'single_select',
          buttonParamsJson: JSON.stringify({
            title: 'Choose from the menu',
            sections: [
              {
                title: 'Choices',
                rows: [
                  { title: 'Option X', id: 'debug_c3_x' },
                  { title: 'Option Y', id: 'debug_c3_y' },
                ],
              },
            ],
          }),
        },
      ],
    },
  ], { text: '[DEBUG] carousel message' });
}

// Default fallback image — picsum.photos is a standard dev placeholder service
const DEBUG_IMG_DEFAULT = 'https://picsum.photos/seed/wazzap/600/400';

async function sendDebugCarouselImg(sock: WaSocketLike, chatId: string, imageUrl: string | null): Promise<void> {
  const url = imageUrl || DEBUG_IMG_DEFAULT;
  await sendCarousel(sock, chatId, [
    {
      image: { url },
      body: 'Card 1 — header image + quick_reply',
      footer: 'Card 1 footer',
      buttons: [
        { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Pick This', id: 'debug_ci1_qr' }) },
        {
          name: 'cta_url',
          buttonParamsJson: JSON.stringify({
            display_text: 'Open Link',
            url: 'https://github.com/chomosuke9/wazzapagents',
            merchant_url: 'https://github.com/chomosuke9/wazzapagents',
          }),
        },
      ],
    },
    {
      image: { url },
      body: 'Card 2 — header image + cta_copy & cta_call',
      footer: 'Card 2 footer',
      buttons: [
        { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: 'Copy Code', id: 'debug_ci2_copy', copy_code: 'IMG-CAROUSEL-789' }) },
        { name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text: 'Call', id: 'debug_ci2_call', phone_number: '+621234567890' }) },
      ],
    },
    {
      // No image — compare rendering with vs without image
      body: 'Card 3 — no header image (baseline)',
      footer: 'Card 3 footer',
      buttons: [
        { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Baseline', id: 'debug_ci3_qr' }) },
      ],
    },
  ], { text: `[DEBUG] carousel + image header (${url})` });
}

async function handleDebugCommand({ chatId, args, sock }: CommandContext): Promise<void> {
  const [subTypeRaw = '', ...restParts] = (args || '').trim().split(/\s+/);
  const subType = subTypeRaw.toLowerCase();
  const extraArg = restParts.join(' ').trim();

  if (!subType || !DEBUG_TYPES.includes(subType)) {
    try {
      await sock.sendMessage(chatId, {
        text: [
          'Usage: `/debug` <type>',
          '',
          `Types: ${DEBUG_TYPES.join(', ')}`,
          '',
          '- buttons      → quick_reply, cta_url, cta_copy, cta_call',
          '- menu         → single_select dropdown',
          '- list         → listMessage (sendList)',
          '- rich         → sendRichMessage without & with buttons',
          '- combined     → all button types in one message',
          '- broadcast    → preview of the broadcast message format',
          '- carousel     → swipeable cards (no header image, experimental)',
          '- carousel-img → swipeable cards with header image (experimental)',
          '                 Optional: `/debug` carousel-img <url>',
          '- all          → buttons + menu + list + rich + combined + broadcast',
        ].join('\n'),
      });
    } catch (err) {
      logger.warn({ err }, 'failed sending debug usage');
    }
    return;
  }

  const send = async (
    fn: (sock: WaSocketLike, chatId: string, ...fnArgs: any[]) => Promise<unknown>,
    label: string,
    ...fnArgs: any[]
  ): Promise<void> => {
    try {
      await fn(sock, chatId, ...fnArgs);
      logger.info({ chatId, label }, 'debug interactive message sent');
    } catch (err: any) {
      logger.warn({ err, label }, 'debug send failed');
      try {
        await sock.sendMessage(chatId, { text: `❌ Failed to send ${label}: ${err?.message || err}` });
      } catch (e) { /* ignore */ }
    }
  };

  if (subType === 'buttons' || subType === 'all') await send(sendDebugButtons, 'buttons');
  if (subType === 'menu' || subType === 'all') await send(sendDebugMenu, 'menu');
  if (subType === 'list' || subType === 'all') await send(sendDebugList, 'list');
  if (subType === 'rich' || subType === 'all') await send(sendDebugRichMessage, 'rich');
  if (subType === 'combined' || subType === 'all') await send(sendDebugCombined, 'combined');
  if (subType === 'broadcast' || subType === 'all') await send(sendDebugBroadcast, 'broadcast');
  if (subType === 'carousel') await send(sendDebugCarousel, 'carousel');
  if (subType === 'carousel-img') await send(sendDebugCarouselImg, 'carousel-img', extraArg || null);
}

export { handleDebugCommand };

export const debugCommand: CommandHandler = {
  commands: ["debug", "debugs"],
  description: "Show technical debug info for this chat.",
  isHidden: true,
  permission: "isOwner",
  run: (_sock, _message, ctx) => handleDebugCommand(ctx),
};