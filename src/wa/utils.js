async function runWithConcurrency(items, concurrency, worker) {
  if (!Array.isArray(items) || items.length === 0) return;
  const limit = Math.max(1, Number(concurrency) || 1);
  let cursor = 0;

  async function consume() {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      await worker(items[idx], idx);
    }
  }

  const workers = [];
  const workerCount = Math.min(limit, items.length);
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(consume());
  }
  await Promise.all(workers);
}

async function withTimeout(promise, timeoutMs, label = 'operation') {
  const timeout = Number(timeoutMs);
  if (!Number.isFinite(timeout) || timeout <= 0) return promise;

  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`${label} timed out`);
          err.code = 'timeout';
          err.detail = `timeout after ${timeout}ms`;
          reject(err);
        }, timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function escapeRegex(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export {
  runWithConcurrency,
  withTimeout,
  escapeRegex,
};
