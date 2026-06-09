import {
  closeAllDbs,
  init,
  setPrompt,
  getPrompt,
  setLlm2Model,
  getLlm2Model,
  setSubagentEnabled,
  getSubagentEnabled,
  setMode,
  getMode,
  addModel,
} from '../../src/db.js';

// Cross-process verification: write a value from Node, then read it back
// to verify WAL-mode consistency. This worker writes known values and then
// reads them back after a short delay to give other workers time to write too.

const workerId = Number(process.env.WORKER_ID || '0');
const iterations = Number(process.env.STRESS_ITERATIONS || '30');
const chatCount = Number(process.env.STRESS_CHAT_COUNT || '12');

function chatIdFor(i) {
  return `xproc-chat-${(workerId + i) % chatCount}@g.us`;
}

try {
  init();
  addModel(`xproc-model-${workerId}`, `CrossProc ${workerId}`, 'test', workerId + 300, false);

  for (let i = 0; i < iterations; i += 1) {
    const chatId = chatIdFor(i);
    const prompt = `xproc-node-${workerId}-${i}-${Date.now()}`;
    const mode = ['auto', 'prefix', 'hybrid'][i % 3];
    const enabled = i % 2 === 0;

    // Write unique values (last-writer-wins is OK in concurrent scenario)
    setPrompt(chatId, `xproc-node-${workerId}-${i}-${Date.now()}`);
    setMode(chatId, mode);
    setSubagentEnabled(chatId, enabled);
    setLlm2Model(chatId, `xproc-model-${workerId}`);

    // Immediately read back — values must exist but may differ from
    // what we just wrote when other workers race on the same chatId.
    // We only verify that reads succeed without error.
    const readPrompt = getPrompt(chatId);
    const readMode = getMode(chatId);
    const readEnabled = getSubagentEnabled(chatId);
    const readModel = getLlm2Model(chatId);

    // Assert that reads return *some* value (not undefined/null)
    if (readPrompt === undefined) {
      throw new Error(`xproc node-${workerId}: prompt for ${chatId} returned undefined`);
    }
    if (readMode === undefined) {
      throw new Error(`xproc node-${workerId}: mode for ${chatId} returned undefined`);
    }
    if (readEnabled === undefined) {
      throw new Error(`xproc node-${workerId}: subagent for ${chatId} returned undefined`);
    }
  }

  closeAllDbs();
  process.exit(0);
} catch (err) {
  try {
    closeAllDbs();
  } catch {
    // ignore
  }
  console.error(err);
  process.exit(1);
}