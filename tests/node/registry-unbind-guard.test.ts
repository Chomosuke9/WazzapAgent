// Regression: a late `close` event from a STALE socket must not unbind a
// client that already reconnected and rebound during the race window.
//
// Before the fix, `unbindClient(folderPath)` cleared `entry.client`
// unconditionally, so an old socket's delayed close would detach the new live
// client — silently diverting all reliable Node->Python frames to the queue
// until the next reconnect.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wazzap-unbind-'));
process.env.DATA_DIR = TMP_DATA_DIR;
process.env.LOG_LEVEL = 'silent';

import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const registry = await import('../../src/server/accountRegistry.ts');

// Minimal stand-in for a bound ws client. Only identity + readyState matter
// for the unbind guard / flush no-op paths.
function fakeClient(): WebSocket {
  return { readyState: WebSocket.OPEN, send() {} } as unknown as WebSocket;
}

test('stale socket close does not unbind a newer reconnected client', () => {
  const folderPath = path.join(TMP_DATA_DIR, 'tenant-reconnect');
  registry.getOrCreate(folderPath);

  const oldClient = fakeClient();
  const newClient = fakeClient();

  registry.bindClient(folderPath, oldClient); // first connection
  registry.bindClient(folderPath, newClient); // reconnect rebinds before old close

  // Old socket's delayed close fires AFTER the new client bound.
  registry.unbindClient(folderPath, oldClient);
  assert.equal(registry.get(folderPath)!.client, newClient, 'newer client must stay bound');

  // The new client's own close still unbinds it.
  registry.unbindClient(folderPath, newClient);
  assert.equal(registry.get(folderPath)!.client, undefined);

  registry.remove(folderPath);
});

test('unbindClient without a socket arg clears unconditionally (back-compat)', () => {
  const folderPath = path.join(TMP_DATA_DIR, 'tenant-uncond');
  registry.getOrCreate(folderPath);
  registry.bindClient(folderPath, fakeClient());

  registry.unbindClient(folderPath);
  assert.equal(registry.get(folderPath)!.client, undefined);

  registry.remove(folderPath);
});
