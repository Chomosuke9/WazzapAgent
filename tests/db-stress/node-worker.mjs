import {
  addModel,
  closeAllDbs,
  getIdleTrigger,
  getMode,
  getPermission,
  getPrompt,
  getSubagentEnabled,
  getTriggers,
  init,
  setGlobalPermission,
  setIdleTrigger,
  setLlm2Model,
  setMode,
  setOwnerContact,
  setPermission,
  setPrompt,
  setSubagentEnabled,
  setTriggers,
} from '../../src/db.js';

const workerId = Number(process.env.WORKER_ID || '0');
const iterations = Number(process.env.STRESS_ITERATIONS || '120');
const chatCount = Number(process.env.STRESS_CHAT_COUNT || '24');
const modes = ['auto', 'prefix', 'hybrid'];
const triggerSets = [new Set(['!', '/']), new Set(['!']), new Set(['/'])];

function chatIdFor(i) {
  return `stress-chat-${(workerId + i) % chatCount}@g.us`;
}

function assertValue(value, message) {
  if (value === undefined) throw new Error(message);
}

try {
  init();
  addModel('stress-node-model', 'Stress Node Model', 'stress-test model', 100, false);

  for (let i = 0; i < iterations; i += 1) {
    const chatId = chatIdFor(i);
    const prompt = `node-${workerId}-${i}-${Date.now()}`;
    const permission = (workerId + i) % 4;
    const mode = modes[(workerId + i) % modes.length];

    switch (i % 9) {
      case 0:
        setPrompt(chatId, prompt);
        assertValue(getPrompt(chatId), 'node prompt read returned undefined');
        break;
      case 1:
        setPermission(chatId, permission);
        assertValue(getPermission(chatId), 'node permission read returned undefined');
        break;
      case 2:
        setMode(chatId, mode);
        assertValue(getMode(chatId), 'node mode read returned undefined');
        break;
      case 3:
        setTriggers(chatId, triggerSets[i % triggerSets.length]);
        assertValue(getTriggers(chatId), 'node triggers read returned undefined');
        break;
      case 4:
        setLlm2Model(chatId, 'stress-node-model');
        break;
      case 5:
        setSubagentEnabled(chatId, i % 2 === 0);
        assertValue(getSubagentEnabled(chatId), 'node subagent read returned undefined');
        break;
      case 6:
        setIdleTrigger(chatId, 1 + (i % 5), 3 + (i % 7));
        assertValue(getIdleTrigger(chatId), 'node idle trigger read returned undefined');
        break;
      case 7:
        setGlobalPermission(permission);
        break;
      default:
        setOwnerContact(`628${workerId}${i}`, `Node Worker ${workerId}`);
        break;
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
