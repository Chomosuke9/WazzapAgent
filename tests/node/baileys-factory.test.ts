import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createOrResumeAccount,
  ensureFolderLayout,
  __setSocketCreatorForTests,
} from '../../src/account/baileysFactory.ts';
import {
  get,
  remove,
} from '../../src/server/accountRegistry.ts';

// Step 17: the factory must run offline. We stub the Baileys socket creator so
// no `fetchLatestBaileysVersion` network call and no real WhatsApp socket are
// ever made. The fake exposes just enough surface for the factory to wire its
// listeners (`ev.on`) and for the shared helpers to read `user`.
class FakeSock {
  ev = { on: (_event: string, _handler: unknown) => {} };
  user = { id: '0@s.whatsapp.net' };
  async sendMessage(): Promise<Record<string, unknown>> {
    return {};
  }
}

function installFakeSocketCreator(): void {
  __setSocketCreatorForTests(async () => new FakeSock() as unknown as never);
}

function tmpFolder(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

test('ensureFolderLayout creates auth/ db/ media/ stickers/ under the tenant folder', () => {
  const folder = tmpFolder('wazzap-layout-');
  try {
    const layout = ensureFolderLayout(folder);
    for (const sub of ['auth', 'db', 'media', 'stickers']) {
      const dir = path.join(folder, sub);
      assert.ok(fs.existsSync(dir), `${sub}/ should be created`);
      assert.ok(fs.statSync(dir).isDirectory(), `${sub}/ should be a directory`);
    }
    assert.equal(layout.authDir, path.join(folder, 'auth'));
    assert.equal(layout.dbDir, path.join(folder, 'db'));
    assert.equal(layout.mediaDir, path.join(folder, 'media'));
    assert.equal(layout.stickersDir, path.join(folder, 'stickers'));
  } finally {
    rmrf(folder);
  }
});

test('two distinct folderPaths -> two registry entries with distinct AccountContexts and auth dirs', async () => {
  installFakeSocketCreator();
  const folderA = tmpFolder('wazzap-acctA-');
  const folderB = tmpFolder('wazzap-acctB-');
  try {
    const entryA = await createOrResumeAccount({ folderPath: folderA, printQr: false });
    const entryB = await createOrResumeAccount({ folderPath: folderB, printQr: false });

    // Two distinct registry entries.
    assert.notStrictEqual(entryA, entryB, 'distinct folders must yield distinct entries');
    assert.strictEqual(get(folderA), entryA);
    assert.strictEqual(get(folderB), entryB);
    assert.equal(entryA.folderPath, folderA);
    assert.equal(entryB.folderPath, folderB);

    // Two distinct AccountContexts (independent per-account state).
    assert.notStrictEqual(entryA.ctx, entryB.ctx, 'each account must own its own context');
    assert.equal(entryA.ctx.folderPath, folderA);
    assert.equal(entryB.ctx.folderPath, folderB);
    assert.notStrictEqual(
      entryA.ctx.messageCache,
      entryB.ctx.messageCache,
      'per-account caches must not be shared',
    );

    // Each account got its own auth dir under its folder.
    assert.ok(fs.existsSync(path.join(folderA, 'auth')), 'account A auth dir created');
    assert.ok(fs.existsSync(path.join(folderB, 'auth')), 'account B auth dir created');

    // Sockets were created (stubbed) and bound.
    assert.ok(entryA.sock, 'account A has a bound socket');
    assert.ok(entryB.sock, 'account B has a bound socket');
    assert.notStrictEqual(entryA.sock, entryB.sock, 'distinct sockets per account');

    // The 4 tenant dirs exist for both folders.
    for (const folder of [folderA, folderB]) {
      for (const sub of ['auth', 'db', 'media', 'stickers']) {
        assert.ok(
          fs.existsSync(path.join(folder, sub)),
          `${folder}/${sub} should exist`,
        );
      }
    }
  } finally {
    remove(folderA);
    remove(folderB);
    rmrf(folderA);
    rmrf(folderB);
    __setSocketCreatorForTests(null);
  }
});

test('same folderPath again returns the SAME entry (idempotent) once a socket is live', async () => {
  installFakeSocketCreator();
  const folder = tmpFolder('wazzap-idem-');
  try {
    const first = await createOrResumeAccount({ folderPath: folder, printQr: false });
    const firstSock = first.sock;
    const firstCtx = first.ctx;

    const second = await createOrResumeAccount({ folderPath: folder, printQr: false });

    assert.strictEqual(second, first, 'same folderPath must return the same entry');
    assert.strictEqual(second.sock, firstSock, 'live socket must not be recreated');
    assert.strictEqual(second.ctx, firstCtx, 'AccountContext must be reused');
  } finally {
    remove(folder);
    rmrf(folder);
    __setSocketCreatorForTests(null);
  }
});
