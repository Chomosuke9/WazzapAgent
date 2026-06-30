import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket, { type WebSocketServer } from 'ws';

import { startWsServer } from '../../src/server/wsServer.ts';
import { __setSocketCreatorForTests } from '../../src/account/baileysFactory.ts';
import {
  get,
  remove,
  sendReliableToClient,
} from '../../src/server/accountRegistry.ts';
import config from '../../src/config.ts';

// ---------------------------------------------------------------------------
// Offline Baileys fake. The factory's socket creator is stubbed so `hello` ->
// createOrResumeAccount never opens a real WhatsApp socket. `user.id` +
// `sendMessage` are the only surfaces sendOutgoing reads for a plain text reply.
// ---------------------------------------------------------------------------
class FakeSock {
  ev = { on: (_event: string, _handler: unknown) => {} };
  user = { id: '0@s.whatsapp.net' };
  async sendMessage(): Promise<Record<string, unknown>> {
    return { key: { id: `wamid-${Math.random().toString(36).slice(2, 8)}` } };
  }
}

function installFakeSocketCreator(): void {
  __setSocketCreatorForTests(async () => new FakeSock() as unknown as never);
}

/** Resolve the ephemeral port the server actually bound to. */
async function listeningPort(wss: WebSocketServer): Promise<number> {
  if (!wss.address()) await once(wss, 'listening');
  const addr = wss.address();
  if (typeof addr === 'object' && addr) return addr.port;
  throw new Error('server not listening on a TCP port');
}

// A buffered frame reader is attached to every client the instant it opens, so
// frames that arrive back-to-back (e.g. action_ack + send_ack, or
// hello_ack + a flushed control event) are NEVER dropped between awaits. The
// previous `once(ws,'message')` approach lost any frame that landed while no
// listener was registered, which hung the test forever.
const readers = new WeakMap<WebSocket, { queue: Record<string, unknown>[]; waiters: Array<(f: Record<string, unknown>) => void> }>();

function attachReader(ws: WebSocket): void {
  const state = { queue: [] as Record<string, unknown>[], waiters: [] as Array<(f: Record<string, unknown>) => void> };
  readers.set(ws, state);
  ws.on('message', (data: WebSocket.RawData) => {
    const frame = JSON.parse(data.toString());
    const waiter = state.waiters.shift();
    if (waiter) waiter(frame);
    else state.queue.push(frame);
  });
}

/** Open a raw ws client, attach the buffered reader, and wait until OPEN. */
async function openClient(port: number, headers?: Record<string, string>): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, headers ? { headers } : undefined);
  attachReader(ws);
  await once(ws, 'open');
  return ws;
}

/** Pull the next buffered JSON frame, or wait (bounded) for one to arrive. */
async function nextFrame(ws: WebSocket, timeoutMs = 5000): Promise<Record<string, unknown>> {
  const state = readers.get(ws);
  if (!state) throw new Error('reader not attached to this client');
  if (state.queue.length) return state.queue.shift()!;
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = state.waiters.indexOf(resolver);
      if (i >= 0) state.waiters.splice(i, 1);
      reject(new Error('timed out waiting for next ws frame'));
    }, timeoutMs);
    const resolver = (f: Record<string, unknown>): void => {
      clearTimeout(timer);
      resolve(f);
    };
    state.waiters.push(resolver);
  });
}

function send(ws: WebSocket, frame: unknown): void {
  ws.send(JSON.stringify(frame));
}

test('hello handshake -> hello_ack with folderPath + waStatus', { timeout: 15000 }, async () => {
  installFakeSocketCreator();
  const wss = startWsServer(0);
  const folderPath = config.dataDir;
  let client: WebSocket | undefined;
  try {
    const port = await listeningPort(wss);
    client = await openClient(port);

    send(client, { type: 'hello', payload: { folderPath, protocolVersion: '2.0' } });
    const ack = await nextFrame(client);

    assert.equal(ack.type, 'hello_ack', 'first frame back is hello_ack');
    assert.equal(ack.payload.folderPath, folderPath);
    assert.ok(
      ['open', 'connecting', 'close'].includes(ack.payload.waStatus),
      'hello_ack carries a normalized waStatus',
    );

    // The client is now bound to the account in the registry.
    const entry = get(folderPath);
    assert.ok(entry, 'account entry exists after handshake');
    assert.ok(entry!.sock, 'Baileys socket created (stubbed) during handshake');
  } finally {
    client?.close();
    await new Promise<void>((r) => wss.close(() => r()));
    remove(config.dataDir);
    __setSocketCreatorForTests(null);
  }
});

test('send_message action -> action_ack(ok) + send_ack', { timeout: 15000 }, async () => {
  installFakeSocketCreator();
  const wss = startWsServer(0);
  // folderPath MUST be config.dataDir so the global getSock() shim (keyed to the
  // default tenant) resolves to our FakeSock and sendOutgoing resolves offline.
  const folderPath = config.dataDir;
  let client: WebSocket | undefined;
  try {
    const port = await listeningPort(wss);
    client = await openClient(port);

    send(client, { type: 'hello', payload: { folderPath, protocolVersion: '2.0' } });
    const ack = await nextFrame(client);
    assert.equal(ack.type, 'hello_ack');

    send(client, {
      type: 'send_message',
      payload: { requestId: 'req-send-1', chatId: '123@s.whatsapp.net', text: 'hello world' },
    });

    // Two frames expected: action_ack + legacy send_ack (order not asserted).
    const f1 = await nextFrame(client);
    const f2 = await nextFrame(client);
    const frames = [f1, f2];

    const actionAck = frames.find((f) => f.type === 'action_ack');
    assert.ok(actionAck, 'action_ack received');
    assert.equal(actionAck.payload.action, 'send_message');
    assert.equal(actionAck.payload.ok, true);
    assert.equal(actionAck.payload.requestId, 'req-send-1');
    assert.ok(Array.isArray(actionAck.payload.result?.sent), 'result carries sent[]');

    const sendAck = frames.find((f) => f.type === 'send_ack');
    assert.ok(sendAck, 'legacy send_ack received');
    assert.equal(sendAck.payload.requestId, 'req-send-1');
  } finally {
    client?.close();
    await new Promise<void>((r) => wss.close(() => r()));
    remove(config.dataDir);
    __setSocketCreatorForTests(null);
  }
});

test('LLM_WS_TOKEN configured: missing/invalid Authorization -> connection rejected', { timeout: 15000 }, async () => {
  installFakeSocketCreator();
  const prevToken = config.wsToken;
  config.wsToken = 'secret-token-123';
  const wss = startWsServer(0);
  try {
    const port = await listeningPort(wss);

    // (i) No Authorization header at all -> upgrade rejected (401), no 'open'.
    const noAuth = new WebSocket(`ws://127.0.0.1:${port}`);
    const [errNoAuth] = (await once(noAuth, 'error')) as [Error];
    assert.ok(errNoAuth, 'missing Authorization is rejected before open');

    // (ii) Wrong token -> also rejected.
    const badAuth = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    const [errBadAuth] = (await once(badAuth, 'error')) as [Error];
    assert.ok(errBadAuth, 'invalid Authorization is rejected before open');

    // (iii) Correct token -> accepted, handshake completes.
    const okClient = await openClient(port, { Authorization: 'Bearer secret-token-123' });
    send(okClient, { type: 'hello', payload: { folderPath: config.dataDir, protocolVersion: '2.0' } });
    const ack = await nextFrame(okClient);
    assert.equal(ack.type, 'hello_ack', 'valid Bearer token is accepted');
    okClient.close();
  } finally {
    await new Promise<void>((r) => wss.close(() => r()));
    remove(config.dataDir);
    config.wsToken = prevToken;
    __setSocketCreatorForTests(null);
  }
});

test('reconnect flush: queued reliable control event delivered AFTER hello_ack', { timeout: 15000 }, async () => {
  installFakeSocketCreator();
  const wss = startWsServer(0);
  const folderPath = '/tmp/wazzap-ws-reconnect-tenant';
  let client2: WebSocket | undefined;
  try {
    const port = await listeningPort(wss);

    // 1) First connection: handshake + bind.
    const client1 = await openClient(port);
    send(client1, { type: 'hello', payload: { folderPath, protocolVersion: '2.0' } });
    const ack1 = await nextFrame(client1);
    assert.equal(ack1.type, 'hello_ack');

    // 2) Disconnect; wait until the server has unbound the client (Baileys kept).
    client1.close();
    for (let i = 0; i < 200 && get(folderPath)?.client; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(get(folderPath)?.client, undefined, 'server unbound the client on close');
    assert.ok(get(folderPath)?.sock, 'Baileys socket kept alive across disconnect');

    // 3) Enqueue a reliable control event while no client is bound -> queues.
    sendReliableToClient(folderPath, { type: 'invalidate_chat_settings', folderPath, chatId: '123@g.us' });
    assert.equal(get(folderPath)?.reliableQueue.length, 1, 'control event queued while unbound');

    // 4) Reconnect: hello -> hello_ack FIRST, then the queued control event.
    client2 = await openClient(port);
    send(client2, { type: 'hello', payload: { folderPath, protocolVersion: '2.0' } });

    const first = await nextFrame(client2);
    assert.equal(first.type, 'hello_ack', 'hello_ack arrives first');

    const second = await nextFrame(client2);
    assert.equal(second.type, 'invalidate_chat_settings', 'queued control event flushed after hello_ack');
    assert.equal(second.chatId, '123@g.us');
    assert.equal(get(folderPath)?.reliableQueue.length, 0, 'queue drained after flush');
  } finally {
    client2?.close();
    await new Promise<void>((r) => wss.close(() => r()));
    remove(folderPath);
    __setSocketCreatorForTests(null);
  }
});
