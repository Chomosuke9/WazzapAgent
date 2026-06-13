import test from 'node:test';
import assert from 'node:assert/strict';
import type WebSocket from 'ws';
import type { AccountEntry } from '../../src/protocol/types.ts';

import { getOrCreate, remove } from '../../src/server/accountRegistry.ts';
import { createAccountContext } from '../../src/account/accountContext.ts';
import { handleIncomingMessage } from '../../src/wa/inbound.ts';

function makeAccount(folderPath: string): AccountEntry {
  const entry = getOrCreate(folderPath);
  entry.ctx = createAccountContext(folderPath);
  // accountContext caches read ctx.sock; inbound also reads entry.ctx.sock.
  entry.sock = { user: { id: 'bot@s.whatsapp.net' } } as never;
  entry.ctx.sock = entry.sock;
  // No bound client needed: an unrecognized-content message returns before
  // forwardIncoming, but a forwarder is wired so the happy path is also safe.
  entry.ctx.forwarder = { forwardIncoming() {} } as never;
  return entry;
}

// Regression: `/catch` resolves its target from ctx.messageCache. Messages whose
// inner content Baileys' getContentType can't resolve (interactive / native-flow
// / echoed-with-stripped-content) previously returned BEFORE being cached, so a
// reply + `/catch` couldn't find them. They must now be remembered.
test('handleIncomingMessage caches a message with unrecognized content so /catch can find it', async () => {
  const folder = '/tenants/catch-cache';
  const entry = makeAccount(folder);
  try {
    const msg = {
      key: { id: 'wamid-interactive-1', remoteJid: '999@s.whatsapp.net' },
      // Key contains neither 'conversation' nor 'Message' -> getContentType
      // returns undefined, mimicking a stripped/unknown interactive proto.
      message: { futureProofPayload: { foo: 1 } },
      messageTimestamp: Math.floor(Date.now() / 1000),
      pushName: 'Tester',
    };

    await handleIncomingMessage(entry, msg as never);

    const cached = entry.ctx.messageCache.get('wamid-interactive-1');
    assert.ok(cached, 'unrecognized-content message must be cached for /catch');
    assert.strictEqual(cached, msg as never, 'the raw proto must be retrievable');
  } finally {
    remove(folder);
  }
});

test('handleIncomingMessage still caches a normal text message', async () => {
  const folder = '/tenants/catch-cache-text';
  const entry = makeAccount(folder);
  try {
    const msg = {
      key: { id: 'wamid-text-1', remoteJid: '999@s.whatsapp.net' },
      message: { conversation: 'hello' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      pushName: 'Tester',
    };

    await handleIncomingMessage(entry, msg as never);

    assert.ok(
      entry.ctx.messageCache.get('wamid-text-1'),
      'normal text message must remain cached',
    );
  } finally {
    remove(folder);
  }
});
