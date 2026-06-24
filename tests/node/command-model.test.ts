import test, { before } from 'node:test';
import assert from 'node:assert/strict';

process.env.REQUIRE_ACTIVATION = 'false';

import { getCommand, parseSlashCommand, initCommandRegistry } from '../../src/wa/command/CommandRegistry.js';

// The registry is populated asynchronously via auto-discovery; initialise it
// once before any lookup (mirrors the gateway's bootstrap()).
before(async () => {
  await initCommandRegistry();
});

// /model and /mode had been folded into the /setting `single_select` menu only.
// They are restored as typed commands because that menu does not render on
// iOS/web/desktop — those callers get the TEXT settings menu and need slash
// commands to change the model / response mode (device-aware compatibility).
test('/model command resolves and parses an argument', () => {
  assert.ok(getCommand('model'), '/model should resolve');
  const parsed = parseSlashCommand('/model gpt-4o');
  assert.ok(parsed, '/model is a known command');
  assert.equal(parsed!.command, 'model');
  assert.equal(parsed!.args, 'gpt-4o');
});

test('/mode command resolves (restored for the text settings menu)', () => {
  assert.ok(getCommand('mode'), '/mode should resolve');
});

test('/compat command + alias resolve', () => {
  assert.ok(getCommand('compat'), '/compat should resolve');
  assert.ok(getCommand('compatibility'), '/compatibility alias should resolve');
});

test('related commands still resolve', () => {
  assert.ok(getCommand('setting'), '/setting must still exist');
  assert.ok(getCommand('modelcfg'), '/modelcfg must still exist');
});
