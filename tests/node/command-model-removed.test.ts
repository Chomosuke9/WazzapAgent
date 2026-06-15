import test, { before } from 'node:test';
import assert from 'node:assert/strict';

process.env.REQUIRE_ACTIVATION = 'false';

import { getCommand, parseSlashCommand, initCommandRegistry } from '../../src/wa/command/CommandRegistry.js';

// The registry is populated asynchronously via auto-discovery; initialise it
// once before any lookup (mirrors the gateway's bootstrap()).
before(async () => {
  await initCommandRegistry();
});

test('/model command is removed (feature 5)', () => {
  assert.equal(getCommand('model'), undefined, '/model should not resolve');
  assert.equal(getCommand('models'), undefined, '/models alias should not resolve');
  assert.equal(parseSlashCommand('/model gpt-4o'), null, '/model is no longer a known command');
});

test('other commands still resolve after /model removal', () => {
  assert.ok(getCommand('setting'), '/setting must still exist');
  assert.ok(getCommand('modelcfg'), '/modelcfg must still exist');
});
