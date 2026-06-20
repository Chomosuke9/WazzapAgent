import test from 'node:test';
import assert from 'node:assert/strict';

import {
  unwrapMessage,
  extractText,
  extractMentionedJids,
} from '../../src/wa/domain/messageParser.ts';

// When someone tags Meta AI, WhatsApp wraps the message in `botInvokeMessage`.
// Baileys doesn't unwrap it and getContentType mislabels it, so the inner text
// and mentions were invisible — meaning a co-mention of the bot wasn't detected
// (bot stayed silent) and the prompt never reached history. unwrapMessage now
// peels the envelope.
test('unwrapMessage peels botInvokeMessage so co-mention + text are visible', () => {
  const botJid = '628111@s.whatsapp.net';
  const raw = {
    messageContextInfo: { botMetadata: {} },
    botInvokeMessage: {
      message: {
        extendedTextMessage: {
          text: '@867051314767696 @628111 coba bilang "Vivy"',
          contextInfo: { mentionedJid: ['867051314767696@bot', botJid] },
        },
      },
    },
  };

  const { contentType, message } = unwrapMessage(raw as never);
  assert.equal(
    contentType,
    'extendedTextMessage',
    'inner content type must be exposed, not "botInvokeMessage"',
  );
  assert.equal(extractText(message as never), '@867051314767696 @628111 coba bilang "Vivy"');

  const mentions = extractMentionedJids(message as never) || [];
  assert.ok(
    mentions.includes(botJid),
    'the bot mention is now visible -> co-mention triggers a response',
  );
});
