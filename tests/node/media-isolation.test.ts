// Regression: per-tenant media/sticker isolation (CONTRACT.md §8).
//  - resolveTenantMediaDirs keeps config globals for the default tenant and
//    gives every other tenant its own <folder>/{media,stickers,stickers_user}.
//  - resolveAllowedAttachmentPath, given a tenant's dirs, accepts a file inside
//    that tenant's media dir and REJECTS a file that lives under another
//    tenant's dir (the cross-tenant leak the global config.mediaDir allowed).
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wazzap-media-'));
process.env.DATA_DIR = path.join(TMP, 'default-tenant');
process.env.LOG_LEVEL = 'silent';

import test from 'node:test';
import assert from 'node:assert/strict';

const config = (await import('../../src/config.ts')).default;
const { resolveTenantMediaDirs, ensureFolderLayout } = await import('../../src/account/baileysFactory.ts');
const { resolveAllowedAttachmentPath } = await import('../../src/mediaHandler.ts');

const actionError = (code: string, message: string) =>
  Object.assign(new Error(message), { code });

test('resolveTenantMediaDirs: default tenant keeps config globals', () => {
  const layout = ensureFolderLayout(config.dataDir);
  const dirs = resolveTenantMediaDirs(config.dataDir, layout);
  assert.equal(dirs.mediaDir, config.mediaDir);
  assert.equal(dirs.stickersDir, config.stickersDir);
  assert.equal(dirs.stickerUploadDir, config.stickerUploadDir);
});

test('resolveTenantMediaDirs: additional tenant gets its own folder', () => {
  const tenant = path.join(TMP, 'tenant-a');
  const layout = ensureFolderLayout(tenant);
  const dirs = resolveTenantMediaDirs(tenant, layout);
  assert.equal(dirs.mediaDir, path.join(tenant, 'media'));
  assert.equal(dirs.stickersDir, path.join(tenant, 'stickers'));
  assert.equal(dirs.stickerUploadDir, path.join(tenant, 'stickers_user'));
});

test('attachment allowlist accepts a file inside the tenant media dir', async () => {
  const tenant = path.join(TMP, 'tenant-b');
  const layout = ensureFolderLayout(tenant);
  const dirs = resolveTenantMediaDirs(tenant, layout);
  const file = path.join(dirs.mediaDir, 'ok.jpg');
  fs.writeFileSync(file, 'x');

  const resolved = await resolveAllowedAttachmentPath(file, actionError, dirs);
  assert.equal(resolved, fs.realpathSync(file));
});

test('attachment allowlist REJECTS another tenant\'s file (cross-tenant leak)', async () => {
  const tenantB = path.join(TMP, 'tenant-b');
  const tenantC = path.join(TMP, 'tenant-c');
  ensureFolderLayout(tenantB);
  const layoutC = ensureFolderLayout(tenantC);
  const dirsC = resolveTenantMediaDirs(tenantC, layoutC);

  // A file that lives under tenant B's media dir...
  const foreign = path.join(tenantB, 'media', 'secret.jpg');
  fs.writeFileSync(foreign, 'x');

  // ...must be rejected when the allowlist is scoped to tenant C.
  await assert.rejects(
    () => resolveAllowedAttachmentPath(foreign, actionError, dirsC),
    /must be inside media or stickers dir/,
  );
});
