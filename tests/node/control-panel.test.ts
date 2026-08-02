import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  createControlPanelServer,
  type ControlPanelAccountRuntimeActions,
  type ControlPanelSystemActions,
} from '../../src/controlPanel/server.ts';
import { stopAccount } from '../../src/account/baileysFactory.ts';
import type { ControlPanelSubagentActions } from '../../src/controlPanel/subagentOutboxClient.ts';
import {
  ProjectUpdateError,
  type UpdateStatus,
} from '../../src/system/updateManager.ts';

const TOKEN = 'x';

async function startFixture(
  token: string | null = TOKEN,
  listenHost = '127.0.0.1',
  systemActions?: ControlPanelSystemActions,
  subagentActions?: ControlPanelSubagentActions,
  accountRuntimeActions?: ControlPanelAccountRuntimeActions,
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
    systemActions,
    subagentActions,
    accountRuntimeActions,
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
      await rm(folder, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 25,
      });
    },
  };
}

function updateStatus(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    checkedAt: '2026-08-02T00:00:00.000Z',
    repositoryAvailable: true,
    upstream: 'origin/main',
    dirty: false,
    ahead: 0,
    behind: 1,
    updateAvailable: true,
    canUpdate: true,
    compatibilityChanged: false,
    current: { version: '1.1.0', compatibilityVersion: '1', commit: 'abc' },
    available: { version: '1.2.0', compatibilityVersion: '1', commit: 'def' },
    message: '1 update commit available.',
    ...overrides,
  };
}

test('control panel accepts any non-empty token and keeps API bearer-protected', async () => {
  const fixture = await startFixture();
  try {
    const page = await fetch(`${fixture.baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /WazzapAgents Control Center/);

    const status = await fetch(`${fixture.baseUrl}/api/auth/status`);
    const authStatus = await status.json() as {
      configured: boolean;
      tokenRequired: boolean;
      host: string;
      port: number;
    };
    assert.equal(authStatus.configured, true);
    assert.equal(authStatus.tokenRequired, true);
    assert.equal(typeof authStatus.host, 'string');
    assert.equal(Number.isInteger(authStatus.port), true);

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

test('system restart and update actions are authenticated and compatibility-gated', async () => {
  let restartCalls = 0;
  let confirmed = false;
  const compatibilityStatus = updateStatus({
    compatibilityChanged: true,
    current: { version: '1.1.0', compatibilityVersion: '1', commit: 'abc' },
    available: { version: '2.0.0', compatibilityVersion: '2', commit: 'def' },
  });
  const actions: ControlPanelSystemActions = {
    getUpdateStatus: async () => compatibilityStatus,
    update: async (confirmCompatibilityChange = false) => {
      if (!confirmCompatibilityChange) {
        throw new ProjectUpdateError(
          'compatibility_change',
          'Compatibility confirmation required.',
          compatibilityStatus,
        );
      }
      confirmed = true;
      return {
        updated: true,
        previousCommit: 'abc',
        currentCommit: 'def',
        status: updateStatus({
          behind: 0,
          updateAvailable: false,
          canUpdate: false,
          compatibilityChanged: false,
          current: { version: '2.0.0', compatibilityVersion: '2', commit: 'def' },
          available: { version: '2.0.0', compatibilityVersion: '2', commit: 'def' },
          message: 'Up to date.',
        }),
      };
    },
    restart: () => { restartCalls += 1; },
  };
  const fixture = await startFixture(TOKEN, '127.0.0.1', actions);
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  };
  try {
    const status = await fetch(`${fixture.baseUrl}/api/system/update-status?refresh=1`, { headers });
    assert.equal(status.status, 200);
    assert.equal((await status.json() as UpdateStatus).compatibilityChanged, true);

    const blocked = await fetch(`${fixture.baseUrl}/api/system/update`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ confirmCompatibilityChange: false }),
    });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json() as { code: string }).code, 'compatibility_change');
    assert.equal(restartCalls, 0);

    const accepted = await fetch(`${fixture.baseUrl}/api/system/update`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ confirmCompatibilityChange: true }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(confirmed, true);
    assert.equal(restartCalls, 1, 'successful update schedules one restart');

    const restart = await fetch(`${fixture.baseUrl}/api/system/restart`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    assert.equal(restart.status, 202);
    assert.equal(restartCalls, 2);
  } finally {
    await fixture.close();
  }
});

test('sub-agent outbox proxy lists, retries, discards, and audits callbacks', async () => {
  const calls: string[] = [];
  const entry = {
    session_id: 'chat@g.us_deadbeef_123',
    state: 'dead_letter' as const,
    completion_status: 'completed',
    callback_status: 422,
    callback_error: 'HTTP 422: invalid_output',
    dead_lettered_at: 1_785_600_000,
    updated_at: 1_785_600_000,
    callback_sequence: 9,
    output_files: [{ name: 'video.mp4', size_bytes: 607_540_207 }],
  };
  const actions: ControlPanelSubagentActions = {
    list: async () => ({ success: true, entries: [entry], count: 1 }),
    retry: async (sessionId) => {
      calls.push(`retry:${sessionId}`);
      return { success: true };
    },
    discard: async (sessionId) => {
      calls.push(`discard:${sessionId}`);
      return { success: true };
    },
  };
  const fixture = await startFixture(TOKEN, '127.0.0.1', undefined, actions);
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  };
  try {
    const unauthorized = await fetch(`${fixture.baseUrl}/api/system/subagent-outbox`);
    assert.equal(unauthorized.status, 401);

    const listed = await fetch(`${fixture.baseUrl}/api/system/subagent-outbox`, { headers });
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json() as { entries: unknown[] }).entries, [entry]);

    const encoded = encodeURIComponent(entry.session_id);
    const retried = await fetch(
      `${fixture.baseUrl}/api/system/subagent-outbox/${encoded}/retry`,
      { method: 'POST', headers, body: '{}' },
    );
    const discarded = await fetch(
      `${fixture.baseUrl}/api/system/subagent-outbox/${encoded}/discard`,
      { method: 'POST', headers, body: '{}' },
    );
    assert.equal(retried.status, 202);
    assert.equal(discarded.status, 200);
    assert.deepEqual(calls, [
      `retry:${entry.session_id}`,
      `discard:${entry.session_id}`,
    ]);

    const logs = await fetch(`${fixture.baseUrl}/api/logs`, { headers });
    const logActions = (await logs.json() as { entries: Array<{ action: string }> })
      .entries.map((item) => item.action);
    assert.ok(logActions.includes('subagent_callback_retried'));
    assert.ok(logActions.includes('subagent_callback_discarded'));
  } finally {
    await fixture.close();
  }
});

test('account API creates, pairs, persists, and removes an isolated tenant', async () => {
  const pairCalls: Array<{ folderPath: string; phoneNumber: string }> = [];
  const runtime: ControlPanelAccountRuntimeActions = {
    pair: async (folderPath, phoneNumber) => {
      pairCalls.push({ folderPath, phoneNumber });
      return { code: 'ABCD-1234', generatedAtMs: 1_785_600_000_000 };
    },
    stop: (folderPath) => stopAccount(folderPath),
  };
  const fixture = await startFixture(
    TOKEN,
    '127.0.0.1',
    undefined,
    undefined,
    runtime,
  );
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  };
  try {
    const created = await fetch(`${fixture.baseUrl}/api/accounts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Support Bot',
        accountKey: 'support',
        phoneNumber: '+62 812-3456-7890',
      }),
    });
    assert.equal(created.status, 201);
    const payload = await created.json() as {
      account: { id: string; name: string; folderPath: string };
      pairing: { code: string };
    };
    assert.equal(payload.account.name, 'Support Bot');
    assert.match(payload.account.folderPath, /tenants[\\/]support$/);
    assert.equal(payload.pairing.code, 'ABCD-1234');
    assert.equal(pairCalls.length, 1);
    assert.equal(pairCalls[0].phoneNumber, '6281234567890');

    const listed = await fetch(`${fixture.baseUrl}/api/accounts`, { headers });
    assert.equal(listed.status, 200);
    const listPayload = await listed.json() as {
      accounts: Array<{ id: string; name: string }>;
      catalog: { managed: boolean; configuredCount: number };
    };
    assert.equal(listPayload.catalog.managed, true);
    assert.equal(listPayload.catalog.configuredCount, 2);
    assert.ok(listPayload.accounts.some((account) => account.name === 'Support Bot'));

    const removed = await fetch(
      `${fixture.baseUrl}/api/accounts/${encodeURIComponent(payload.account.id)}`,
      {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ confirm: 'REMOVE' }),
      },
    );
    assert.equal(removed.status, 200);
    assert.equal((await removed.json() as { dataPreserved: boolean }).dataPreserved, true);

    const after = await fetch(`${fixture.baseUrl}/api/accounts`, { headers });
    const afterPayload = await after.json() as {
      accounts: Array<{ id: string }>;
      catalog: { configuredCount: number };
    };
    assert.equal(afterPayload.catalog.configuredCount, 1);
    assert.equal(afterPayload.accounts.some((account) => account.id === payload.account.id), false);
  } finally {
    await fixture.close();
  }
});
