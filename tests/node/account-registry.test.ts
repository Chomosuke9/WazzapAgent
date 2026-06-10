import test from 'node:test';
import assert from 'node:assert/strict';
import type WebSocket from 'ws';
import type { OutboundFrame } from '../../migration/node/protocol/types.ts';

import {
  getOrCreate,
  get,
  bindClient,
  sendToClient,
  sendReliableToClient,
  flushReliableQueue,
  remove,
  MAX_RELIABLE_QUEUE,
} from '../../migration/node/server/accountRegistry.ts';

// The `ws` OPEN constant value is 1 (per the WebSocket spec / ws library).
const OPEN = 1;

/**
 * Minimal fake of a `ws` WebSocket: exposes the OPEN readyState and a send()
 * that records every transmitted (string) frame so tests can assert delivery
 * order. Cast to WebSocket at the call site (tests are not type-checked, but
 * this keeps the intent explicit).
 */
class FakeWebSocket {
  readyState = OPEN;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
}

function makeFrame(n: number): OutboundFrame {
  // `invalidate_default_model` is the simplest OutboundFrame variant; folderPath
  // doubles as a per-frame marker so we can assert ordering after flush.
  return { type: 'invalidate_default_model', folderPath: `frame-${n}` };
}

test('getOrCreate is idempotent (same object for same folderPath)', () => {
  const folder = '/tenants/idempotent';
  const first = getOrCreate(folder);
  const second = getOrCreate(folder);
  assert.strictEqual(first, second, 'same folderPath must return the same object');
  assert.strictEqual(get(folder), first);
  assert.equal(first.folderPath, folder);
  assert.deepEqual(first.reliableQueue, []);
  remove(folder);
});

test('sendReliableToClient enqueues with no client, then bindClient + flushReliableQueue delivers in order', () => {
  const folder = '/tenants/reliable-order';
  const frames = [makeFrame(1), makeFrame(2), makeFrame(3)];

  // No client bound yet -> all frames queue.
  for (const frame of frames) sendReliableToClient(folder, frame);
  assert.equal(getOrCreate(folder).reliableQueue.length, 3, 'frames should be queued while no client');

  // Bind an OPEN client (bindClient flushes), then flush again (no-op) to
  // exercise flushReliableQueue explicitly.
  const stub = new FakeWebSocket();
  bindClient(folder, stub as unknown as WebSocket);
  flushReliableQueue(folder);

  assert.equal(stub.sent.length, 3, 'all queued frames should be delivered');
  assert.deepEqual(
    stub.sent.map((s) => JSON.parse(s)),
    frames,
    'frames delivered in FIFO order',
  );
  assert.equal(getOrCreate(folder).reliableQueue.length, 0, 'queue drained after flush');
  remove(folder);
});

test('sendReliableToClient drops oldest past MAX_RELIABLE_QUEUE (length stays <= 1000)', () => {
  const folder = '/tenants/overflow';
  const total = MAX_RELIABLE_QUEUE + 50; // push more than the bound, no client bound
  for (let i = 0; i < total; i += 1) sendReliableToClient(folder, makeFrame(i));

  const entry = getOrCreate(folder);
  assert.equal(entry.reliableQueue.length, MAX_RELIABLE_QUEUE, 'queue length capped at MAX_RELIABLE_QUEUE');
  assert.ok(entry.reliableQueue.length <= 1000, 'queue length never exceeds 1000');

  // Oldest (frame-0 .. frame-49) dropped; head is frame-50.
  const head = entry.reliableQueue[0] as { folderPath: string };
  assert.equal(head.folderPath, `frame-${total - MAX_RELIABLE_QUEUE}`, 'oldest frames dropped first');
  remove(folder);
});

test('sendToClient with no client is a no-op (no throw, no enqueue)', () => {
  const folder = '/tenants/best-effort';
  assert.doesNotThrow(() => sendToClient(folder, makeFrame(1)));

  const entry = get(folder);
  // Best-effort send must never create a queue entry.
  if (entry) {
    assert.equal(entry.reliableQueue.length, 0, 'best-effort send must not enqueue');
  } else {
    // Acceptable: sendToClient does not even create an entry when none exists.
    assert.equal(entry, undefined);
  }
  remove(folder);
});
