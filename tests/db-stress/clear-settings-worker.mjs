import {
  closeAllDbs,
  init,
  setPrompt,
  getPrompt,
  setPermission,
  getPermission,
  setMode,
  getMode,
  setTriggers,
  getTriggers,
  setSubagentEnabled,
  getSubagentEnabled,
  setIdleTrigger,
  getIdleTrigger,
  clearSettings,
  addModel,
  getLlm2Model,
  setLlm2Model,
} from '../../src/db.js';

const workerId = Number(process.env.WORKER_ID || '0');
const iterations = Number(process.env.STRESS_ITERATIONS || '60');
const chatCount = Number(process.env.STRESS_CHAT_COUNT || '24');

function chatIdFor(i) {
  return `stress-chat-${(workerId + i) % chatCount}@g.us`;
}

// Stress test: interleaved write-then-clear-then-write on the same chat IDs.
// This exercises the ensureChatRow race-condition fix (INSERT OR IGNORE)
// and verifies the DB remains consistent after clears.
try {
  init();
  addModel('stress-clear-model', 'Stress Clear Model', 'stress-test clear model', 200, false);

  for (let i = 0; i < iterations; i += 1) {
    const chatId = chatIdFor(i);
    switch (i % 5) {
      case 0:
        setPrompt(chatId, `clear-test-${workerId}-${i}`);
        break;
      case 1:
        setPermission(chatId, i % 4);
        break;
      case 2:
        setMode(chatId, ['auto', 'prefix', 'hybrid'][i % 3]);
        break;
      case 3:
        clearSettings(chatId);
        break;
      default:
        setLlm2Model(chatId, 'stress-clear-model');
        break;
    }
  }

  // Verify that after all the clears, we can still write and read back
  for (let i = 0; i < Math.min(8, iterations); i += 1) {
    const chatId = chatIdFor(i);
    setPrompt(chatId, `post-clear-${workerId}-${i}`);
    const readback = getPrompt(chatId);
    if (readback !== `post-clear-${workerId}-${i}`) {
      throw new Error(`clear-stress: prompt mismatch for ${chatId}: got ${readback}`);
    }
  }

  closeAllDbs();
  process.exit(0);
} catch (err) {
  try {
    closeAllDbs();
  } catch {
    // ignore close errors from already-failed stress workers
  }
  console.error(err);
  process.exit(1);
}