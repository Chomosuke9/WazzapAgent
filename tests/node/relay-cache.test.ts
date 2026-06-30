import test from 'node:test';
import assert from 'node:assert/strict';

import { createAccountContext } from '../../src/account/accountContext.ts';
import { installRelayMessageCache } from '../../src/account/baileysFactory.ts';

// Bot-sent interactive messages (buttons / carousel / copy-code / rich / the
// /setting & /modelcfg menus / quiz) and Lottie stickers are sent via
// `relayMessage`, never `sendMessage`, and are never echoed back to the sending
// socket. `installRelayMessageCache` wraps `relayMessage` once (in the factory)
// so each relayed proto lands in `ctx.messageCache` keyed by its wamid, which
// is exactly what `/catch` (and resolveQuotedMessage) read.

test('relayed messages are cached by wamid so a reply + /catch can resolve them', async () => {
  const ctx = createAccountContext('/tenants/relay-cache');
  const relayed: Array<string | undefined> = [];
  ctx.sock = {
    user: { id: 'bot@s.whatsapp.net' },
    relayMessage: async (_jid: string, _message: unknown, options: Record<string, unknown>) => {
      relayed.push(options?.messageId as string | undefined);
      return options?.messageId as string | undefined;
    },
  } as never;

  installRelayMessageCache(ctx);

  const jid = '12345@g.us';
  const message = { interactiveMessage: { body: { text: 'hi' } } };
  await ctx.sock!.relayMessage(jid, message as never, { messageId: 'wamid-int-1' } as never);

  assert.equal(relayed.length, 1, 'the original relayMessage must still run');
  const cached: Record<string, unknown> | undefined = ctx.messageCache.get('wamid-int-1');
  assert.ok(cached, 'relayed interactive message must be cached for /catch');
  assert.strictEqual(cached.message, message, 'cached proto must carry the relayed content');
  assert.equal(cached.key.id, 'wamid-int-1');
  assert.equal(cached.key.remoteJid, jid);
  assert.equal(cached.key.fromMe, true);
});

test('installRelayMessageCache is a no-op when the socket lacks relayMessage', () => {
  const ctx = createAccountContext('/tenants/relay-cache-nosock');
  ctx.sock = { user: { id: 'bot@s.whatsapp.net' }, sendMessage: async () => ({}) } as never;
  // Must not throw (mirrors the test FakeSock, which has no relayMessage).
  installRelayMessageCache(ctx);
  assert.equal(ctx.messageCache.size, 0);
});
