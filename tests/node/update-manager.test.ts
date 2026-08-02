import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseReleaseMetadata,
  ProjectUpdateError,
  ProjectUpdateManager,
} from '../../src/system/updateManager.ts';

test('release metadata carries a separate compatibility version', () => {
  assert.deepEqual(
    parseReleaseMetadata(JSON.stringify({ version: '2.4.0', compatibilityVersion: 3 })),
    { version: '2.4.0', compatibilityVersion: '3' },
  );
  assert.deepEqual(
    parseReleaseMetadata(JSON.stringify({ version: '1.0.0' })),
    { version: '1.0.0', compatibilityVersion: 'unknown' },
  );
  assert.throws(
    () => parseReleaseMetadata('{'),
    (error: unknown) => error instanceof ProjectUpdateError && error.code === 'invalid_metadata',
  );
});

test('update status fails closed outside a Git checkout', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wazzap-update-status-'));
  try {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ version: '1.1.0', compatibilityVersion: 1 }),
      'utf8',
    );
    const status = await new ProjectUpdateManager(root).getStatus(false);
    assert.equal(status.repositoryAvailable, false);
    assert.equal(status.canUpdate, false);
    assert.equal(status.current.compatibilityVersion, '1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
