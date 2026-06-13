import test from 'node:test';
import assert from 'node:assert/strict';

process.env.REQUIRE_ACTIVATION = 'false';

import { getCommand, parseSlashCommand } from '../../src/wa/commands/CommandRegistry.js';

test('/model command is removed (feature 5)', () => {
  assert.equal(getCommand('model'), undefined, '/model should not resolve');
  assert.equal(getCommand('models'), undefined, '/models alias should not resolve');
  assert.equal(parseSlashCommand('/model gpt-4o'), null, '/model is no longer a known command');
});

test('other commands still resolve after /model removal', () => {
  assert.ok(getCommand('setting'), '/setting must still exist');
  assert.ok(getCommand('modelcfg'), '/modelcfg must still exist');
  assert.ok(getCommand('mode'), '/mode must still exist');
});
