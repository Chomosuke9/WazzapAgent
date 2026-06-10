import test from 'node:test';
import assert from 'node:assert/strict';
import type WebSocket from 'ws';

import {
  forwardIncoming,
  forwardStatus,
  normalizeWaStatus,
} from '../../migration/node/account/eventForwarder.ts';
import {
  getOrCreate,
  bindClient,
  flushReliableQueue,
  remove,
} from '../../migration/node/server/accountRegistry.ts';

// The `ws` OPEN constant value is 1 (per the WebSocket spec / ws library).
const OPEN = 1;

/**
 * Minimal fake of a `ws` WebSocket: OPEN readyState + a send() that records
 * every transmitted (string) frame so tests can assert delivery + isolation.
 */
class FakeWebSocket {
  readyState = OPEN;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
}

/** Build a minimal incoming-message payload (tests are not type-checked). */
function makePayload(text: string): any {
  return {
    instanceId: 'test-instance',
    chatId: '123@g.us',
    chatName: 'Test Group',
    chatType: 'group',
    messageId: 'wamid-test',
    senderId: '99@s.whatsapp.net',
    senderRef: 'u00001',
    senderName: 'Alice',
    senderIsAdmin: false,
    senderIsSuperAdmin: false,
    isGroup: true,
    botIsAdmin: false,
    botIsSuperAdmin: false,
    fromMe: false,
    contextOnly: false,
    triggerLlm1: false,
    timestampMs: 1738560000000,
    messageType: 'conversation',
    text,
    attachments: [],
  };
}

test('forwardIncoming delivers ONLY to the bound account client and stamps folderPath', () => {
  const folderA = '/tenants/fwd-incoming-A';
  const folderB = '/tenants/fwd-incoming-B';
  const entryA = getOrCreate(folderA);
  const entryB = getOrCreate(folderB);

  const clientA = new FakeWebSocket();
  const clientB = new FakeWebSocket();
  bindClient(folderA, clientA as unknown as WebSocket);
  bindClient(folderB, clientB as unknown as WebSocket);

  try {
    forwardIncoming(entryA, makePayload('hello A') as any);

    // Only A's client received the frame; B is untouched.
    assert.equal(clientA.sent.length, 1, "A's client must receive exactly one frame");
    assert.equal(clientB.sent.length, 0, "B's client must receive nothing");

    const frame = JSON.parse(clientA.sent[0]);
    assert.equal(frame.type, 'incoming_message');
    assert.equal(frame.payload.folderPath, folderA, 'folderPath must be stamped to account A');
    assert.equal(frame.payload.text, 'hello A');
  } finally {
    remove(folderA);
    remove(folderB);
  }
});

test('forwardStatus normalizes a close connection.update to status "close" (not "closed")', () => {
  const folderA = '/tenants/fwd-status-close';
  const entryA = getOrCreate(folderA);
  const clientA = new FakeWebSocket();
  bindClient(folderA, clientA as unknown as WebSocket);

  try {
    // Feed the RAW Baileys close value to prove closed->close normalization.
    forwardStatus(entryA, 'closed' as any, 401);

    assert.equal(clientA.sent.length, 1, 'whatsapp_status delivered to bound client');
    const frame = JSON.parse(clientA.sent[0]);
    assert.equal(frame.type, 'whatsapp_status');
    assert.equal(frame.payload.status, 'close', 'status must be normalized to "close"');
    assert.notEqual(frame.payload.status, 'closed');
    assert.equal(frame.payload.folderPath, folderA);
    assert.equal(frame.payload.reason, 401, 'disconnect reason is forwarded');

    // Sanity-check the exported normalizer directly.
    assert.equal(normalizeWaStatus('closed'), 'close');
    assert.equal(normalizeWaStatus('close'), 'close');
    assert.equal(normalizeWaStatus('open'), 'open');
    assert.equal(normalizeWaStatus('connecting'), 'connecting');
  } finally {
    remove(folderA);
  }
});

test('forwardStatus queues reliably while unbound and delivers after bindClient + flush', () => {
  const folderC = '/tenants/fwd-status-unbound';
  const entryC = getOrCreate(folderC);

  try {
    // No client bound yet -> the reliable whatsapp_status frame must queue.
    forwardStatus(entryC, 'open');
    assert.equal(entryC.reliableQueue.length, 1, 'status frame queued while client unbound');

    // Bind an OPEN client (bindClient flushes); flush again to be explicit.
    const clientC = new FakeWebSocket();
    bindClient(folderC, clientC as unknown as WebSocket);
    flushReliableQueue(folderC);

    assert.equal(clientC.sent.length, 1, 'queued status frame delivered after bind');
    const frame = JSON.parse(clientC.sent[0]);
    assert.equal(frame.type, 'whatsapp_status');
    assert.equal(frame.payload.status, 'open');
    assert.equal(frame.payload.folderPath, folderC);
    assert.equal(entryC.reliableQueue.length, 0, 'queue drained after flush');
  } finally {
    remove(folderC);
  }
});
