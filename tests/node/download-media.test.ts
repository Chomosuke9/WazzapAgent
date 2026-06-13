import test from 'node:test';
import assert from 'node:assert/strict';
import type WebSocket from 'ws';
import type { AccountEntry } from '../../src/protocol/types.ts';

import { getOrCreate, bindClient, remove } from '../../src/server/accountRegistry.ts';
import { createAccountContext } from '../../src/account/accountContext.ts';
import { dispatchAction, type DispatchDeps } from '../../src/account/actionDispatcher.ts';

const OPEN = 1;

class FakeWebSocket {
  readyState = OPEN;
  sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  frames(): any[] { return this.sent.map((s) => JSON.parse(s)); }
}

function makeAccount(folderPath: string): { entry: AccountEntry; client: FakeWebSocket } {
  const entry = getOrCreate(folderPath);
  entry.ctx = createAccountContext(folderPath);
  entry.sock = { user: { id: 'bot@s.whatsapp.net' } } as any;
  const client = new FakeWebSocket();
  bindClient(folderPath, client as unknown as WebSocket);
  return { entry, client };
}

test('download_media downloads on demand for a cached message (feature 8)', async () => {
  const folder = '/tenants/dl-hit';
  const { entry, client } = makeAccount(folder);

  // Seed a cached image message proto.
  entry.ctx.messageCache.set('wamid-img-1', {
    key: { id: 'wamid-img-1', remoteJid: '123@g.us' },
    message: { imageMessage: { mimetype: 'image/jpeg' } },
  } as any);

  let saveCalled = 0;
  const deps: Partial<DispatchDeps> = {
    saveMedia: (async () => {
      saveCalled++;
      return {
        kind: 'image', mime: 'image/jpeg', fileName: 'wamid-img-1_image.jpg',
        originalFileName: null, jpegThumbnail: null, size: 1234,
        path: '/data/media/wamid-img-1_image.jpg', isAnimated: false,
      };
    }) as DispatchDeps['saveMedia'],
  };

  await dispatchAction(
    entry,
    { type: 'download_media', payload: { requestId: 'dl-1', chatId: '123@g.us', messageId: 'wamid-img-1' } },
    deps,
  );

  assert.equal(saveCalled, 1, 'saveMedia invoked once');
  const ack = client.frames().find((f) => f.type === 'action_ack');
  assert.ok(ack);
  assert.equal(ack.payload.action, 'download_media');
  assert.equal(ack.payload.ok, true);
  assert.equal(ack.payload.result.path, '/data/media/wamid-img-1_image.jpg');
  assert.equal(ack.payload.result.messageId, 'wamid-img-1');

  remove(folder);
});

test('download_media replies not_found when the proto was evicted', async () => {
  const folder = '/tenants/dl-miss';
  const { entry, client } = makeAccount(folder);

  let saveCalled = 0;
  const deps: Partial<DispatchDeps> = {
    saveMedia: (async () => { saveCalled++; return null; }) as DispatchDeps['saveMedia'],
  };

  await dispatchAction(
    entry,
    { type: 'download_media', payload: { requestId: 'dl-2', chatId: '123@g.us', messageId: 'gone-xyz' } },
    deps,
  );

  assert.equal(saveCalled, 0, 'saveMedia not called for missing proto');
  const ack = client.frames().find((f) => f.type === 'action_ack');
  assert.ok(ack);
  assert.equal(ack.payload.ok, false);
  assert.equal(ack.payload.code, 'not_found');

  remove(folder);
});
