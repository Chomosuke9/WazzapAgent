import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createControlPanelServer } from '../../src/controlPanel/server.ts';

const TOKEN = 'test-admin-token-1234';

async function startFixture(): Promise<{
  baseUrl: string;
  envPath: string;
  close: () => Promise<void>;
}> {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'wazzap-control-panel-'));
  const envPath = path.join(folder, '.env');
  const examplePath = path.join(folder, '.env.example');
  await writeFile(
    envPath,
    'LLM2_API_KEY=super-secret-value\nPRIVATE_CHAT_ENABLED=true\n',
    'utf8',
  );
  await writeFile(
    examplePath,
    [
      '# Secret provider key',
      'LLM2_API_KEY=',
      '# Private chat switch',
      'PRIVATE_CHAT_ENABLED=true',
      'CONTROL_PANEL_TOKEN=',
    ].join('\n'),
    'utf8',
  );
  const server = createControlPanelServer({
    tokenProvider: () => TOKEN,
    envPath,
    examplePath,
    auditPath: path.join(folder, 'audit.jsonl'),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP server did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    envPath,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(folder, { recursive: true, force: true });
    },
  };
}

test('control panel serves setup assets and keeps API bearer-protected', async () => {
  const fixture = await startFixture();
  try {
    const page = await fetch(`${fixture.baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /WazzapAgents Control Center/);

    const status = await fetch(`${fixture.baseUrl}/api/auth/status`);
    assert.deepEqual(await status.json(), {
      configured: true,
      minimumTokenLength: 16,
    });

    const unauthorized = await fetch(`${fixture.baseUrl}/api/overview`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${fixture.baseUrl}/api/overview`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(authorized.status, 200);
    const body = await authorized.json() as { health: { nodeGateway: string } };
    assert.equal(body.health.nodeGateway, 'online');
  } finally {
    await fixture.close();
  }
});

test('environment API masks secrets and updates only authenticated values', async () => {
  const fixture = await startFixture();
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  };
  try {
    const response = await fetch(`${fixture.baseUrl}/api/system/environment`, { headers });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      fields: Array<{ key: string; value: string; configured: boolean; secret: boolean }>;
    };
    const secret = body.fields.find((field) => field.key === 'LLM2_API_KEY');
    assert.deepEqual(secret, {
      key: 'LLM2_API_KEY',
      value: '',
      configured: true,
      secret: true,
      category: 'LLM2 responder',
      description: 'Secret provider key',
      defaultValue: '',
      source: 'env_file',
      restartRequired: true,
    });

    const weakToken = await fetch(`${fixture.baseUrl}/api/system/environment`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ values: { CONTROL_PANEL_TOKEN: 'too-short' } }),
    });
    assert.equal(weakToken.status, 400);

    const update = await fetch(`${fixture.baseUrl}/api/system/environment`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ values: { PRIVATE_CHAT_ENABLED: 'false' } }),
    });
    assert.equal(update.status, 200);
    const saved = await readFile(fixture.envPath, 'utf8');
    assert.match(saved, /PRIVATE_CHAT_ENABLED=false/);
    assert.match(saved, /LLM2_API_KEY=super-secret-value/);
    assert.doesNotMatch(saved, /CONTROL_PANEL_TOKEN=too-short/);
    assert.doesNotMatch(JSON.stringify(await update.json()), /super-secret-value/);
  } finally {
    await fixture.close();
  }
});
