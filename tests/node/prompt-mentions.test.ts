// Feature 2: `/prompt <text>` must persist @-mentions in the canonical
// `@Name (senderRef)` form (the shape the outbound renderer understands),
// not the raw `@<localpart>` that WhatsApp puts in the message body.
//
// WhatsApp never includes display names in the text — the body only carries
// `@<localpart>` while the full JIDs live in `contextInfo.mentionedJid`. The
// helper extracts those JIDs, resolves a name + senderRef, and rewrites the
// raw token in place. Text without mentions must pass through unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAccountContext } from '../../src/account/accountContext.ts';
import { rememberSenderRef } from '../../src/wa/domain/identifiers.ts';
import { rewritePromptMentions } from '../../src/wa/commands/prompt.ts';

function makeMessage(mentionedJid: string[], text: string) {
  return {
    key: { remoteJid: '12345@g.us', id: 'wamid-test', fromMe: false },
    message: {
      extendedTextMessage: {
        text,
        contextInfo: { mentionedJid },
      },
    },
  } as never;
}

test('rewritePromptMentions rewrites @<localpart> into @Name (senderRef)', async () => {
  const ctx = createAccountContext('/tenants/prompt-mentions');
  const chatId = '12345@g.us';
  const jid = '628123@s.whatsapp.net';

  // The senderRef the helper must produce is exactly what rememberSenderRef
  // returns for this JID/chat (idempotent registration).
  const expectedRef = rememberSenderRef(ctx, chatId, jid, jid);
  assert.ok(expectedRef, 'expected a senderRef to be allocated');

  const msg = makeMessage([jid], 'be nice to @628123');
  const result = await rewritePromptMentions(ctx, chatId, 'be nice to @628123', msg);

  // No cached display name → falls back to the numeric localpart "628123".
  assert.equal(result, `be nice to @628123 (${expectedRef})`);
});

test('rewritePromptMentions leaves text without mentions unchanged', async () => {
  const ctx = createAccountContext('/tenants/prompt-mentions-none');
  const chatId = '12345@g.us';

  const msg = makeMessage([], 'just a plain prompt with no mentions');
  const result = await rewritePromptMentions(
    ctx,
    chatId,
    'just a plain prompt with no mentions',
    msg,
  );

  assert.equal(result, 'just a plain prompt with no mentions');
});

test('rewritePromptMentions does not match a token that is a prefix of a longer number', async () => {
  const ctx = createAccountContext('/tenants/prompt-mentions-boundary');
  const chatId = '12345@g.us';
  const jid = '628123@s.whatsapp.net';

  const expectedRef = rememberSenderRef(ctx, chatId, jid, jid);
  // The body contains @6281234567 (a longer number) — the @628123 token for
  // our mentioned JID must NOT partially match inside it.
  const text = 'ping @6281234567 please';
  const msg = makeMessage([jid], text);
  const result = await rewritePromptMentions(ctx, chatId, text, msg);

  assert.equal(result, text, 'longer adjacent number must be left untouched');
  assert.ok(expectedRef);
});
