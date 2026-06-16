// outbound-bot-mention.test.ts — Feature 1 regression guard.
//
// `@<anything> (bot)` in outbound text must become a REAL clickable WhatsApp
// mention of the bot itself: the bot's own JID must appear in the `mentions`
// array AND the token must render as the `@<localpart>` handle (so WhatsApp
// renders a tap-able mention). When the bot JID cannot be resolved (no socket
// / missing user.id), it must safely fall back to plain-text rendering and add
// NO JID to the mentions array.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAccountContext } from '../../src/account/accountContext.ts';
import { renderOutboundMentions } from '../../src/wa/outbound.ts';

test('(bot) token becomes a real mention of the bot JID with an @<localpart> handle', async () => {
  const ctx = createAccountContext('/tenants/bot-mention');
  // Minimal live socket: renderOutboundMentions only reads ctx.sock?.user?.id.
  ctx.sock = { user: { id: '15551234567:1@s.whatsapp.net' } } as never;

  const rendered = await renderOutboundMentions(
    ctx,
    '12345@g.us',
    'hey @Wazzap (bot) what do you think?',
  );

  // The bot's own (normalized) JID is attached to the mention array.
  assert.deepEqual(rendered.mentions, ['15551234567@s.whatsapp.net']);
  // The token renders as the @<localpart> handle so WhatsApp shows a mention.
  assert.ok(
    rendered.text.includes('@15551234567'),
    `expected @<localpart> handle in text, got: ${rendered.text}`,
  );
  // The literal "(bot)" parenthetical token is consumed (not left in the text).
  assert.ok(!rendered.text.includes('(bot)'), 'the (bot) token must be replaced');
});

test('(bot) token falls back to plain text when the bot JID cannot be resolved', async () => {
  const ctx = createAccountContext('/tenants/bot-mention-no-sock');
  // No ctx.sock at all — the bot JID cannot be resolved.

  const rendered = await renderOutboundMentions(
    ctx,
    '12345@g.us',
    'hey @Wazzap (bot) hello',
  );

  // No JID added; safe plain-text fallback preserving the display name.
  assert.deepEqual(rendered.mentions, []);
  assert.ok(
    rendered.text.includes('@Wazzap'),
    `expected plain @Wazzap fallback, got: ${rendered.text}`,
  );
});
