import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createControlPanelServer } from '../../src/controlPanel/server.ts';

const TOKEN = 'x';

async function startFixture(
  token: string | null = TOKEN,
  listenHost = '127.0.0.1',
): Promise<{
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
      'CONTROL_PANEL_HOST=127.0.0.1',
      'CONTROL_PANEL_PORT=8080',
      'CONTROL_PANEL_TOKEN=',
    ].join('\n'),
    'utf8',
  );
  const server = createControlPanelServer({
    tokenProvider: () => token,
    envPath,
    examplePath,
    auditPath: path.join(folder, 'audit.jsonl'),
  });
  server.listen(0, listenHost);
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

test('control panel accepts any non-empty token and keeps API bearer-protected', async () => {
  const fixture = await startFixture();
  try {
    const page = await fetch(`${fixture.baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /WazzapAgents Control Center/);

    const status = await fetch(`${fixture.baseUrl}/api/auth/status`);
    assert.deepEqual(await status.json(), {
      configured: true,
      tokenRequired: true,
      host: '127.0.0.1',
      port: 8080,
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

test('control panel remains setup-only when the token is empty', async () => {
  const fixture = await startFixture('');
  try {
    const status = await fetch(`${fixture.baseUrl}/api/auth/status`);
    assert.equal(status.status, 200);
    assert.equal((await status.json() as { configured: boolean }).configured, false);

    const management = await fetch(`${fixture.baseUrl}/api/overview`, {
      headers: { Authorization: 'Bearer x' },
    });
    assert.equal(management.status, 503);
  } finally {
    await fixture.close();
  }
});

test('control panel can bind all IPv4 interfaces for Tailscale or LAN access', async () => {
  const fixture = await startFixture(TOKEN, '0.0.0.0');
  try {
    const response = await fetch(`${fixture.baseUrl}/api/overview`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200);
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

    const shortToken = await fetch(`${fixture.baseUrl}/api/system/environment`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ values: { CONTROL_PANEL_TOKEN: 'too-short' } }),
    });
    assert.equal(shortToken.status, 200);

    const network = await fetch(`${fixture.baseUrl}/api/system/environment`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        values: { CONTROL_PANEL_HOST: '0.0.0.0', CONTROL_PANEL_PORT: '8088' },
      }),
    });
    assert.equal(network.status, 200);

    const invalidHost = await fetch(`${fixture.baseUrl}/api/system/environment`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ values: { CONTROL_PANEL_HOST: 'http://invalid' } }),
    });
    assert.equal(invalidHost.status, 400);

    const update = await fetch(`${fixture.baseUrl}/api/system/environment`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ values: { PRIVATE_CHAT_ENABLED: 'false' } }),
    });
    assert.equal(update.status, 200);
    const saved = await readFile(fixture.envPath, 'utf8');
    assert.match(saved, /PRIVATE_CHAT_ENABLED=false/);
    assert.match(saved, /LLM2_API_KEY=super-secret-value/);
    assert.match(saved, /CONTROL_PANEL_TOKEN=too-short/);
    assert.match(saved, /CONTROL_PANEL_HOST=0\.0\.0\.0/);
    assert.match(saved, /CONTROL_PANEL_PORT=8088/);
    assert.doesNotMatch(saved, /http:\/\/invalid/);
    assert.doesNotMatch(JSON.stringify(await update.json()), /super-secret-value/);
  } finally {
    await fixture.close();
  }
});
