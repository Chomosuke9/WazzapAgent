import {
  closeAllDbs,
  init,
  setPrompt,
  getPrompt,
  setPermission,
  getPermission,
  setSubagentEnabled,
  getSubagentEnabled,
  addModel,
} from '../../src/db.js';

// Test that multiple Node processes can call init() concurrently on the same
// databases without crashing. This used to cause UNIQUE constraint violations
// because ensureChatRow did a SELECT then INSERT non-atomically.
const workerId = Number(process.env.WORKER_ID || '0');
const iterations = Number(process.env.STRESS_ITERATIONS || '30');

try {
  // init() is the critical part — it creates tables and the __global__ row.
  // If multiple processes call it concurrently, they may both try to insert
  // the __global__ row at the same time.
  init();

  // Also exercise addModel concurrently — it inserts into llm_models.
  addModel(`init-stress-model-${workerId}`, `Init Stress ${workerId}`, 'test', workerId, false);

  // Write some chat data to trigger ensureChatRow
  for (let i = 0; i < iterations; i += 1) {
    const chatId = `init-chat-${workerId}-${i}@g.us`;
    setPrompt(chatId, `init-${workerId}-${i}`);
    if (i % 3 === 0) {
      setPermission(chatId, i % 4);
    }
    if (i % 5 === 0) {
      setSubagentEnabled(chatId, i % 2 === 0);
    }
  }

  // Verify reads
  for (let i = 0; i < iterations; i += 1) {
    const chatId = `init-chat-${workerId}-${i}@g.us`;
    const prompt = getPrompt(chatId);
    if (prompt !== `init-${workerId}-${i}`) {
      throw new Error(`init-stress worker ${workerId}: prompt mismatch for ${chatId}: got ${prompt}`);
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