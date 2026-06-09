// Set env BEFORE any import of src/* (config.js reads env at import time,
// and src/logger.js also reads LOG_LEVEL at import time; LOG_LEVEL must be
// lowercase for pino to accept it). The static imports below (node builtins,
// `ws`) do not read these env vars, so static-importing them first is safe.
// `src/wsClient.js` is imported dynamically after env is set.
process.env.LOG_LEVEL = 'info';
process.env.LLM_WS_ENDPOINT = 'ws://127.0.0.1:1/ws';
process.env.WS_HEARTBEAT_INTERVAL_MS = '200';
process.env.WS_HEARTBEAT_TIMEOUT_MS = '80';
process.env.WS_RECONNECT_MS = '50';
process.env.WS_RECONNECT_MAX_MS = '500';
process.env.WS_RECONNECT_JITTER_RATIO = '0';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

const { LLMWebSocket, computeReconnectDelay } = await import('../../src/wsClient.js');
const { default: config } = await import('../../src/config.js');

async function startServer() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const port = server.address().port;
  config.wsEndpoint = `ws://127.0.0.1:${port}/ws`;
  return { server, port };
}

async function closeServer(server) {
  server.close();
  await once(server, 'close');
}

test('computeReconnectDelay grows exponentially and caps', () => {
  const opts = { baseMs: 1000, maxMs: 60000, jitterRatio: 0, rand: () => 0.5 };
  assert.equal(computeReconnectDelay({ ...opts, attempt: 1 }), 1000);
  assert.equal(computeReconnectDelay({ ...opts, attempt: 2 }), 2000);
  assert.equal(computeReconnectDelay({ ...opts, attempt: 3 }), 4000);
  assert.equal(computeReconnectDelay({ ...opts, attempt: 4 }), 8000);
  assert.equal(computeReconnectDelay({ ...opts, attempt: 5 }), 16000);
  assert.equal(computeReconnectDelay({ ...opts, attempt: 6 }), 32000);
  assert.equal(computeReconnectDelay({ ...opts, attempt: 7 }), 60000);
  assert.equal(computeReconnectDelay({ ...opts, attempt: 8 }), 60000);
  assert.equal(computeReconnectDelay({ ...opts, attempt: 0 }), 0);
  assert.equal(computeReconnectDelay({ ...opts, attempt: -1 }), 0);
  assert.equal(computeReconnectDelay({ ...opts, attempt: NaN }), 0);
});

test('computeReconnectDelay applies bounded jitter and caps the jittered result', () => {
  const base = { baseMs: 1000, maxMs: 60000, jitterRatio: 0.2, attempt: 1 };
  assert.equal(computeReconnectDelay({ ...base, rand: () => 0 }), 800);
  assert.equal(computeReconnectDelay({ ...base, rand: () => 1 }), 1200);
  assert.equal(computeReconnectDelay({ ...base, rand: () => 0.5 }), 1000);
  const extreme = computeReconnectDelay({
    baseMs: 10,
    maxMs: 60000,
    jitterRatio: 1,
    attempt: 1,
    rand: () => 0,
  });
  assert.equal(extreme, 0);
  // Jitter must never push the delay above maxMs even when
  // jitterRatio * rand() * 2 - 1 would naively compute past the cap.
  const capped = computeReconnectDelay({
    baseMs: 40000,
    maxMs: 50000,
    jitterRatio: 0.5,
    attempt: 1,
    rand: () => 1,
  });
  assert.equal(capped, 50000);
  for (let i = 0; i < 100; i++) {
    const r = Math.random();
    const d = computeReconnectDelay({
      baseMs: 1000,
      maxMs: 60000,
      jitterRatio: 0.5,
      attempt: 3,
      rand: () => r,
    });
    assert.ok(d >= 0, `delay must be >= 0, got ${d}`);
    assert.ok(d <= 60000, `delay must be <= maxMs, got ${d}`);
  }
});

test('connect sends hello handshake to server', { timeout: 5000 }, async () => {
  const { server } = await startServer();
  const client = new LLMWebSocket();
  const serverConn = new Promise((resolve) => {
    server.once('connection', (sock) => {
      sock.once('message', (data) => resolve({ sock, msg: JSON.parse(data.toString()) }));
    });
  });
  client.connect();
  const [result] = await Promise.all([serverConn, once(client, 'connected')]);
  assert.deepEqual(result.msg, {
    type: 'hello',
    payload: { instanceId: 'default', role: 'whatsapp-gateway' },
  });
  assert.equal(client.isConnected(), true);
  assert.equal(client.getAttempt(), 0);
  await client.close();
  result.sock.close();
  await closeServer(server);
});

test('attempt counter resets only after stable grace elapses', { timeout: 12000 }, async () => {
  const { server, port } = await startServer();
  const client = new LLMWebSocket();
  let firstServerSock = null;
  server.on('connection', (sock) => {
    if (!firstServerSock) firstServerSock = sock;
  });
  client.connect();
  await once(client, 'connected');

  firstServerSock.close();
  await once(client, 'disconnected');
  assert.ok(
    client.getAttempt() >= 1,
    `expected attempt >= 1 after disconnect, got ${client.getAttempt()}`
  );

  await closeServer(server);
  await new Promise((r) => setTimeout(r, 30));

  const server2 = new WebSocketServer({ port, host: '127.0.0.1' });
  await once(server2, 'listening');

  await once(client, 'connected');
  // Immediately after reconnect the counter is NOT yet reset (flap
  // resistance): accept-then-kick servers shouldn't clear the backoff.
  const attemptRightAfterReconnect = client.getAttempt();
  assert.ok(
    attemptRightAfterReconnect >= 1,
    `attempt must persist through the grace window, got ${attemptRightAfterReconnect}`
  );

  // Wait past Math.max(config.wsReconnectIntervalMs, 5000) so the grace
  // timer fires and resets attempt to 0.
  const graceMs = Math.max(config.wsReconnectIntervalMs, 5000);
  await new Promise((r) => setTimeout(r, graceMs + 200));
  assert.equal(client.getAttempt(), 0);

  await client.close();
  await closeServer(server2);
});

test('sendReliable queues while disconnected and flushes in order on reconnect',
  { timeout: 5000 },
  async () => {
    const client = new LLMWebSocket();
    client.sendReliable({ type: 'a' });
    client.sendReliable({ type: 'b' });
    assert.equal(client.getReliableQueueSize(), 2);

    const { server } = await startServer();
    const received = [];
    let serverSock = null;
    server.on('connection', (sock) => {
      serverSock = sock;
      sock.on('message', (data) => received.push(JSON.parse(data.toString())));
    });

    client.connect();
    await once(client, 'connected');
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(received.length, 3);
    assert.equal(received[0].type, 'hello');
    assert.equal(received[1].type, 'a');
    assert.equal(received[2].type, 'b');
    assert.equal(client.getReliableQueueSize(), 0);

    await client.close();
    if (serverSock) serverSock.close();
    await closeServer(server);
  }
);

test('heartbeat terminates socket when server swallows pings', { timeout: 5000 }, async () => {
  const { server } = await startServer();
  const connSocks = [];
  server.on('connection', (sock) => {
    // Swallow the automatic pong so the client never observes a reply
    // to its ping. The next heartbeat tick should then observe isAlive
    // still false and call ws.terminate(), forcing a close event.
    sock.pong = () => {};
    connSocks.push(sock);
  });

  const client = new LLMWebSocket();
  client.connect();
  await once(client, 'connected');

  const disconnected = once(client, 'disconnected');
  const safety = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('heartbeat disconnect did not fire within 2s')), 2000)
  );
  await Promise.race([disconnected, safety]);

  await client.close();
  for (const s of connSocks) {
    try { s.terminate(); } catch { /* ignore */ }
  }
  await closeServer(server);
});

test('heartbeat stays healthy when server auto-pongs', { timeout: 5000 }, async () => {
  // Positive path: a normal ws server auto-pongs to pings, so the
  // isAlive flag is re-asserted every tick and the socket must never
  // be terminated by the heartbeat.
  const prevInterval = config.wsHeartbeatIntervalMs;
  config.wsHeartbeatIntervalMs = 100;
  try {
    const { server } = await startServer();
    const connSocks = [];
    server.on('connection', (sock) => {
      connSocks.push(sock);
    });

    const client = new LLMWebSocket();
    let disconnectedFired = false;
    client.on('disconnected', () => {
      disconnectedFired = true;
    });
    client.connect();
    await once(client, 'connected');

    // Let several heartbeat intervals elapse (at 100ms cadence → 5 ticks).
    await new Promise((r) => setTimeout(r, 500));

    assert.equal(client.isConnected(), true);
    assert.equal(disconnectedFired, false);

    await client.close();
    for (const s of connSocks) {
      try { s.terminate(); } catch { /* ignore */ }
    }
    await closeServer(server);
  } finally {
    config.wsHeartbeatIntervalMs = prevInterval;
  }
});

test('close() is idempotent', { timeout: 5000 }, async () => {
  const { server } = await startServer();
  const connSocks = [];
  server.on('connection', (sock) => connSocks.push(sock));

  const client = new LLMWebSocket();
  client.connect();
  await once(client, 'connected');

  await client.close();
  assert.equal(client.isConnected(), false);
  assert.equal(client.getReliableQueueSize(), 0);

  // Second call must not throw and must leave state identical.
  await client.close();
  assert.equal(client.isConnected(), false);
  assert.equal(client.getReliableQueueSize(), 0);

  for (const s of connSocks) {
    try { s.terminate(); } catch { /* ignore */ }
  }
  await closeServer(server);
});

test('close() while reconnect timer is armed cancels the reconnect', { timeout: 5000 }, async () => {
  const { server } = await startServer();
  const connSocks = [];
  server.on('connection', (sock) => connSocks.push(sock));

  const client = new LLMWebSocket();
  client.connect();
  await once(client, 'connected');

  // Stop the server so the client's socket closes and scheduleReconnect
  // arms its timer. We do NOT wait for the reconnect itself to fire.
  const disconnected = once(client, 'disconnected');
  for (const s of connSocks) {
    try { s.terminate(); } catch { /* ignore */ }
  }
  await closeServer(server);
  await disconnected;

  const attemptAtDisconnect = client.getAttempt();
  assert.ok(attemptAtDisconnect >= 1);

  let laterConnected = false;
  let laterDisconnected = false;
  client.on('connected', () => { laterConnected = true; });
  client.on('disconnected', () => { laterDisconnected = true; });

  // Close while the reconnect timer is still armed.
  await client.close();

  // Give the (now-cancelled) reconnect timer enough wall time to fire
  // several times over; confirm nothing happened.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(laterConnected, false);
  assert.equal(laterDisconnected, false);
  assert.equal(client.getAttempt(), attemptAtDisconnect);
  assert.equal(client.isConnected(), false);
});

test('close() cancels timers and drops queued messages', { timeout: 2000 }, async () => {
  const client = new LLMWebSocket();
  client.sendReliable({ type: 'x' });
  client.sendReliable({ type: 'y' });
  assert.equal(client.getReliableQueueSize(), 2);

  let disconnectedFired = false;
  client.on('disconnected', () => {
    disconnectedFired = true;
  });

  await client.close();
  assert.equal(client.getReliableQueueSize(), 0);

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(disconnectedFired, false);
  assert.equal(client.isConnected(), false);
});

test('close() does not strip external listeners on the instance', { timeout: 5000 }, async () => {
  // Regression guard: src/index.js registers `wsClient.on('message', ...)`
  // before calling `connect()`. close() must NOT nuke that subscription.
  const { server } = await startServer();
  const connSocks = [];
  server.on('connection', (sock) => connSocks.push(sock));

  const client = new LLMWebSocket();
  const received = [];
  const onMessage = (msg) => received.push(msg);
  client.on('message', onMessage);

  client.connect();
  await once(client, 'connected');
  await client.close();

  // The listener the caller registered must still be attached.
  assert.equal(client.listenerCount('message'), 1);
  assert.ok(client.listeners('message').includes(onMessage));

  for (const s of connSocks) {
    try { s.terminate(); } catch { /* ignore */ }
  }
  await closeServer(server);
});
