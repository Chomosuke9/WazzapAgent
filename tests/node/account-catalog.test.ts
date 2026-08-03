import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import {
  AccountCatalog,
  AccountCatalogError,
  MANAGED_ACCOUNTS_MARKER,
} from '../../src/account/accountCatalog.ts';

async function fixture(): Promise<{
  root: string;
  catalog: AccountCatalog;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wazzap-account-catalog-'));
  const envPath = path.join(root, '.env');
  await writeFile(envPath, 'NODE_URL=ws://127.0.0.1:3000\nFOLDER_PATH=./data\n', 'utf8');
  return {
    root,
    catalog: new AccountCatalog({ rootDir: root, envPath, environment: {} }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('managed account catalog migrates fallback config and preserves stable slots', async () => {
  const item = await fixture();
  try {
    const initial = await item.catalog.read();
    assert.equal(initial.source, 'fallback');
    assert.deepEqual(initial.accounts.map((account) => account.slot), [0]);

    const addedA = await item.catalog.add({ accountKey: 'support' });
    const addedB = await item.catalog.add({ accountKey: 'sales' });
    assert.equal(addedA.account.folderPath, path.join(item.root, 'tenants', 'support'));
    assert.equal(addedB.account.slot, 2);
    assert.deepEqual(addedB.snapshot.accounts.map((account) => account.slot), [0, 1, 2]);

    await item.catalog.remove(addedA.account.folderPath);
    const afterRemoval = await item.catalog.read();
    assert.deepEqual(afterRemoval.accounts.map((account) => account.slot), [0, 2]);

    const replacement = await item.catalog.add({ accountKey: 'operations' });
    assert.equal(replacement.account.slot, 1, 'lowest free slot is reused without moving sales');
    assert.equal(
      replacement.snapshot.accounts.find((account) => account.folderPath.endsWith('sales'))?.slot,
      2,
    );

    const saved = JSON.parse(await readFile(path.join(item.root, 'accounts.json'), 'utf8'));
    assert.equal(saved.managed_by, MANAGED_ACCOUNTS_MARKER);
    assert.deepEqual(saved.accounts.map((account: { slot: number }) => account.slot), [0, 2, 1]);
  } finally {
    await item.cleanup();
  }
});

test('managed account catalog upgrades legacy entries with distinct WS credentials', async () => {
  const item = await fixture();
  try {
    await item.catalog.add({ accountKey: 'support' });
    const secured = await item.catalog.ensureWsTokens();
    const tokens = secured.accounts.map((account) => account.wsToken);
    assert.ok(tokens.every((token): token is string => typeof token === 'string' && token.length >= 32));
    assert.equal(new Set(tokens).size, tokens.length);

    const reread = await item.catalog.read();
    assert.deepEqual(reread.accounts.map((account) => account.wsToken), tokens);
  } finally {
    await item.cleanup();
  }
});

test('managed catalog rejects unsafe IDs, duplicates, and removing the final account', async () => {
  const item = await fixture();
  try {
    await assert.rejects(
      item.catalog.add({ accountKey: '../escape' }),
      (error: unknown) => error instanceof AccountCatalogError
        && error.code === 'invalid_account',
    );
    const added = await item.catalog.add({ accountKey: 'support' });
    await assert.rejects(
      item.catalog.add({ accountKey: 'support' }),
      (error: unknown) => error instanceof AccountCatalogError
        && error.code === 'duplicate_account',
    );
    await item.catalog.remove(added.snapshot.accounts[0].folderPath);
    await assert.rejects(
      item.catalog.remove(added.account.folderPath),
      (error: unknown) => error instanceof AccountCatalogError
        && error.code === 'last_account',
    );
  } finally {
    await item.cleanup();
  }
});

test('explicit account config validates duplicate slots and folder paths', async () => {
  const item = await fixture();
  try {
    const explicitPath = path.join(item.root, 'custom-accounts.json');
    await writeFile(
      explicitPath,
      JSON.stringify({
        accounts: [
          { folder_path: './tenants/a', slot: 4 },
          { folder_path: './tenants/b', slot: 4 },
        ],
      }),
      'utf8',
    );
    const catalog = new AccountCatalog({
      rootDir: item.root,
      envPath: path.join(item.root, '.env'),
      environment: { ACCOUNTS_JSON: explicitPath },
    });
    await assert.rejects(catalog.read(), /Duplicate account slot: 4/);

    await writeFile(
      explicitPath,
      JSON.stringify({ accounts: ['./tenants/a', './tenants/../tenants/a'] }),
      'utf8',
    );
    await assert.rejects(catalog.read(), /Duplicate account folder_path/);
  } finally {
    await item.cleanup();
  }
});
