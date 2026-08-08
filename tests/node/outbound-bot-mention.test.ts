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
import {
  repairMissingMentionPrefixes,
  renderOutboundMentions,
} from '../../src/wa/outbound.ts';
import { rememberParticipantName } from '../../src/wa/domain/participants.ts';
import { rememberSenderRef } from '../../src/wa/domain/identifiers.ts';

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

test('known person mention missing @ is repaired before outbound rendering', async () => {
  const ctx = createAccountContext('/tenants/person-mention-repair');
  const chatId = '12345@g.us';
  const participantJid = '15557654321@s.whatsapp.net';
  const senderRef = rememberSenderRef(ctx, chatId, participantJid, participantJid);
  assert.ok(senderRef);
  rememberParticipantName(ctx, participantJid, 'Alice Example');

  const rendered = await renderOutboundMentions(
    ctx,
    chatId,
    `thanks Alice Example (${senderRef}) for helping`,
  );

  assert.deepEqual(rendered.mentions, [participantJid]);
  assert.ok(rendered.text.includes('@15557654321'));
  assert.ok(!rendered.text.includes(`(${senderRef})`));
});

test('unknown parenthesized text is not converted into a mention', async () => {
  const ctx = createAccountContext('/tenants/person-mention-no-false-positive');
  const rendered = await renderOutboundMentions(
    ctx,
    '12345@g.us',
    'deploy version (stable) tomorrow',
  );

  assert.equal(rendered.text, 'deploy version (stable) tomorrow');
  assert.deepEqual(rendered.mentions, []);
});

test('persistent command arguments repair missing @ before dispatch', () => {
  const ctx = createAccountContext('/tenants/command-mention-repair');
  const chatId = '12345@g.us';
  const participantJid = '15557654321@s.whatsapp.net';
  const senderRef = rememberSenderRef(ctx, chatId, participantJid, participantJid);
  assert.ok(senderRef);
  rememberParticipantName(ctx, participantJid, 'Alice Example');

  for (const command of [
    `/schedule-task 30M Remind Alice Example (${senderRef}) about lunch`,
    `/daily-task add 08:00 Remind Alice Example (${senderRef}) about lunch`,
    `/prompt Always greet Alice Example (${senderRef}) politely`,
    `/memory add Alice Example (${senderRef}) likes tea`,
  ]) {
    const repaired = repairMissingMentionPrefixes(ctx, chatId, command);
    assert.ok(
      repaired.includes(`@Alice Example (${senderRef})`),
      `expected canonical mention in ${repaired}`,
    );
  }
});

test('reserved all, admin, and bot mentions missing @ are repaired', () => {
  const ctx = createAccountContext('/tenants/reserved-mention-repair');
  const chatId = '12345@g.us';

  assert.equal(
    repairMissingMentionPrefixes(ctx, chatId, 'Attention all (all)'),
    'Attention @all (all)',
  );
  assert.equal(
    repairMissingMentionPrefixes(ctx, chatId, 'Ask admin (admin)'),
    'Ask @admin (admin)',
  );
  assert.equal(
    repairMissingMentionPrefixes(ctx, chatId, 'Hello Vivy (bot)'),
    'Hello @Vivy (bot)',
  );
  assert.equal(
    repairMissingMentionPrefixes(ctx, chatId, 'deploy version (stable)'),
    'deploy version (stable)',
  );
});

test('missing @all reaches the real group-mention renderer', async () => {
  const ctx = createAccountContext('/tenants/reserved-all-render');
  const rendered = await renderOutboundMentions(
    ctx,
    '12345@g.us',
    'Attention all (all)',
  );

  assert.equal(rendered.text, 'Attention @all');
  assert.equal(rendered.nonJidMentions, 1);
});
