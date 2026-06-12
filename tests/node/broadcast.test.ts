// Ported from the legacy tests/node/broadcast.test.mjs (Phase 0, step-01).
//
// The legacy `src/wa/command/broadcast.js` `reconstructAndSend` had complex
// branching (sendMessage with reconstructed linkPreview for invite links /
// canonical URLs, plain-text sendMessage, relayMessage for newsletter
// forwards). That module was deleted. The migration `broadcast.ts`
// `reconstructAndSend` (this target) is a relay-only reconstruction: it wraps
// the cached message with `generateWAMessageFromContent` and relays it via the
// per-account JID send queue (`withJidQueue(ctx, jid, ...)`). These tests
// validate that current behavior rather than the obsolete legacy branching.
process.env.LOG_LEVEL = 'warn';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { reconstructAndSend } = await import('../../src/wa/command/broadcast.ts');

// Minimal fake AccountContext: reconstructAndSend only touches `ctx.jidQueues`
// (through withJidQueue), a per-JID serialization Map.
const makeCtx = () => ({ jidQueues: new Map() });

// Mock sock with call tracking.
const makeSock = () => {
  const calls = { sendMessage: [], relayMessage: [] };
  return {
    user: { id: 'bot@s.whatsapp.net' },
    sendMessage: async (...args) => { calls.sendMessage.push(args); },
    relayMessage: async (...args) => { calls.relayMessage.push(args); },
    _calls: calls,
  };
};

describe('reconstructAndSend (migration relay-only behavior)', () => {
  it('relays a plain-text cached message via relayMessage to the target jid', async () => {
    const ctx = makeCtx();
    const sock = makeSock();
    const cachedMsg = { message: { conversation: 'hello' } };

    const result = await reconstructAndSend(ctx, sock, 'target@g.us', cachedMsg);

    assert.equal(result.ok, true);
    assert.equal(sock._calls.relayMessage.length, 1, 'relayMessage should be called once');
    assert.equal(sock._calls.sendMessage.length, 0, 'sendMessage should not be called');
    assert.equal(sock._calls.relayMessage[0][0], 'target@g.us', 'relays to the target jid');
  });

  it('relays an extendedTextMessage (e.g. forwarded link) via relayMessage', async () => {
    const ctx = makeCtx();
    const sock = makeSock();
    const cachedMsg = {
      message: { extendedTextMessage: { text: 'https://example.com', matchedText: 'https://example.com' } },
    };

    const result = await reconstructAndSend(ctx, sock, 'target@g.us', cachedMsg);

    assert.equal(result.ok, true);
    assert.equal(sock._calls.relayMessage.length, 1);
    assert.equal(sock._calls.sendMessage.length, 0);
  });

  it('returns ok:false when the cached message has no content', async () => {
    const ctx = makeCtx();
    const sock = makeSock();
    const cachedMsg = { message: null };

    const result = await reconstructAndSend(ctx, sock, 'target@g.us', cachedMsg);

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'error');
    assert.equal(sock._calls.relayMessage.length, 0, 'no send attempted for empty message');
    assert.equal(sock._calls.sendMessage.length, 0);
  });

  it('returns ok:false when relayMessage throws', async () => {
    const ctx = makeCtx();
    const sock = makeSock();
    sock.relayMessage = async () => { throw new Error('network down'); };
    const cachedMsg = { message: { conversation: 'hello' } };

    const result = await reconstructAndSend(ctx, sock, 'target@g.us', cachedMsg);

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'error');
  });
});
