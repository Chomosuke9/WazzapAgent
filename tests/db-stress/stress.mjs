import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const workerDir = path.join(rootDir, 'tests/db-stress');

const workerPaths = {
  node: path.join(workerDir, 'node-worker.mjs'),
  python: path.join(workerDir, 'python_worker.py'),
  clearSettings: path.join(workerDir, 'clear-settings-worker.mjs'),
  concurrentInit: path.join(workerDir, 'concurrent-init-worker.mjs'),
  xprocNode: path.join(workerDir, 'xproc-verify-worker.mjs'),
  xprocPython: path.join(workerDir, 'xproc-verify-python.py'),
};

const pythonBin = process.env.PYTHON || process.env.PYTHON_BIN || 'python3';
const nodeWorkers = Number(process.env.STRESS_NODE_WORKERS || '4');
const pythonWorkers = Number(process.env.STRESS_PYTHON_WORKERS || '4');
const iterations = Number(process.env.STRESS_ITERATIONS || '120');
const chatCount = Number(process.env.STRESS_CHAT_COUNT || '24');

function dbPaths(dataDir) {
  return {
    settings: path.join(dataDir, 'settings.db'),
    stats: path.join(dataDir, 'stats.db'),
    moderation: path.join(dataDir, 'moderation.db'),
  };
}

function stressEnv(dataDir, extra = {}) {
  const paths = dbPaths(dataDir);
  return {
    ...process.env,
    DATA_DIR: dataDir,
    SETTINGS_DB_PATH: paths.settings,
    STATS_DB_PATH: paths.stats,
    MODERATION_DB_PATH: paths.moderation,
    BOT_SETTINGS_DB_PATH: paths.settings,
    BOT_STATS_DB_PATH: paths.stats,
    BOT_MODERATION_DB_PATH: paths.moderation,
    LOG_LEVEL: process.env.LOG_LEVEL || 'silent',
    DB_BUSY_TIMEOUT_MS: process.env.DB_BUSY_TIMEOUT_MS || '30000',
    DB_BUSY_TIMEOUT_SECONDS: process.env.DB_BUSY_TIMEOUT_SECONDS || '30',
    DB_OPERATION_RETRY_MAX: process.env.DB_OPERATION_RETRY_MAX || '8',
    DB_OPERATION_RETRY_BASE_MS: process.env.DB_OPERATION_RETRY_BASE_MS || '50',
    DB_OPERATION_RETRY_BASE_SECONDS: process.env.DB_OPERATION_RETRY_BASE_SECONDS || '0.05',
    STRESS_ITERATIONS: String(iterations),
    STRESS_CHAT_COUNT: String(chatCount),
    ...extra,
  };
}

function pipeChild(child, label) {
  child.stdout.on('data', (data) => process.stdout.write(`[${label}] ${data}`));
  child.stderr.on('data', (data) => process.stderr.write(`[${label}] ${data}`));
}

function runChild(command, args, env, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: rootDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    pipeChild(child, label);
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${label} failed with code=${code} signal=${signal}`));
    });
  });
}

async function initSchema(dataDir) {
  const env = stressEnv(dataDir);
  const dbModuleUrl = pathToFileURL(path.join(rootDir, 'src/db.js'));
  dbModuleUrl.search = `?stress=${Date.now()}-${Math.random()}`;
  Object.assign(process.env, env);
  const db = await import(dbModuleUrl.href);
  db.init();
  db.closeAllDbs();
}

async function runConcurrentWorkers(dataDir) {
  const jobs = [];
  for (let i = 0; i < nodeWorkers; i += 1) {
    jobs.push(
      runChild(
        process.execPath,
        [workerPaths.node],
        stressEnv(dataDir, { WORKER_ID: String(i) }),
        `node-${i}`,
      ),
    );
  }
  for (let i = 0; i < pythonWorkers; i += 1) {
    jobs.push(
      runChild(
        pythonBin,
        [workerPaths.python],
        stressEnv(dataDir, { WORKER_ID: String(i + nodeWorkers) }),
        `python-${i}`,
      ),
    );
  }
  await Promise.all(jobs);
}

function assertIntegrity(dbPath, tables) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const integrityRows = db.pragma('integrity_check');
    const allOk = integrityRows.every((row) => row.integrity_check === 'ok');
    if (!allOk) throw new Error(`${dbPath} failed integrity_check: ${JSON.stringify(integrityRows)}`);

    const journalMode = db.pragma('journal_mode', { simple: true });
    if (journalMode !== 'wal') throw new Error(`${dbPath} journal_mode=${journalMode}`);

    for (const table of tables) {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
      if (!row || row.count <= 0) throw new Error(`${dbPath} has no rows in ${table}`);
    }
  } finally {
    db.close();
  }
}

function verifyStressData(dataDir) {
  const paths = dbPaths(dataDir);
  assertIntegrity(paths.settings, ['chat_settings', 'llm_models']);
  assertIntegrity(paths.stats, ['chat_stats', 'chat_user_stats']);
  assertIntegrity(paths.moderation, ['chat_mutes']);
}

function verifySettingsOnly(dataDir) {
  const paths = dbPaths(dataDir);
  assertIntegrity(paths.settings, ['chat_settings', 'llm_models']);
}

async function runCorruptionRecoveryCheck() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazzap-db-corrupt-'));
  const paths = dbPaths(dataDir);
  await fs.mkdir(dataDir, { recursive: true });
  await Promise.all(Object.values(paths).map((dbPath) => fs.writeFile(dbPath, 'not a sqlite database')));

  await Promise.all([
    runChild(process.execPath, [workerPaths.node], stressEnv(dataDir, { WORKER_ID: '1000', STRESS_ITERATIONS: '16' }), 'recovery-node'),
    runChild(pythonBin, [workerPaths.python], stressEnv(dataDir, { WORKER_ID: '2000', STRESS_ITERATIONS: '16' }), 'recovery-python'),
  ]);

  verifyStressData(dataDir);

  const backups = await Promise.all(
    Object.values(paths).map(async (dbPath) => {
      const basename = path.basename(dbPath);
      const files = await fs.readdir(path.dirname(dbPath));
      return files.some((file) => file.startsWith(`${basename}.corrupted`) && file.endsWith('.bak'));
    }),
  );
  if (!backups.every(Boolean)) throw new Error('corrupt database backups were not preserved for every DB');
}

// ---------------------------------------------------------------------------
// New test: concurrent clearSettings — interleaved writes and clears on the
// same chat IDs from multiple Node workers.
// ---------------------------------------------------------------------------
async function runClearSettingsStress() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazzap-db-clear-'));
  const clearWorkers = Math.min(nodeWorkers, 4);
  const clearIters = Math.min(iterations, 60);
  const clearChats = Math.min(chatCount, 12);

  await initSchema(dataDir);

  const jobs = [];
  for (let i = 0; i < clearWorkers; i += 1) {
    jobs.push(
      runChild(
        process.execPath,
        [workerPaths.clearSettings],
        stressEnv(dataDir, {
          WORKER_ID: String(i),
          STRESS_ITERATIONS: String(clearIters),
          STRESS_CHAT_COUNT: String(clearChats),
        }),
        `clear-${i}`,
      ),
    );
  }
  await Promise.all(jobs);
  verifySettingsOnly(dataDir);
  console.log('  clear-settings stress test passed');
}

// ---------------------------------------------------------------------------
// New test: concurrent init() — multiple processes initialising the same DBs
// at the same time. Exercises the INSERT OR IGNORE fix in ensureChatRow.
// ---------------------------------------------------------------------------
async function runConcurrentInitStress() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazzap-db-init-'));
  // Do NOT call initSchema() here — we want all workers to race on init().
  const initWorkers = Math.min(nodeWorkers, 4);
  const initIters = Math.min(iterations, 30);

  const jobs = [];
  for (let i = 0; i < initWorkers; i += 1) {
    jobs.push(
      runChild(
        process.execPath,
        [workerPaths.concurrentInit],
        stressEnv(dataDir, {
          WORKER_ID: String(i),
          STRESS_ITERATIONS: String(initIters),
        }),
        `init-${i}`,
      ),
    );
  }
  await Promise.all(jobs);
  verifySettingsOnly(dataDir);
  console.log('  concurrent-init stress test passed');
}

// ---------------------------------------------------------------------------
// New test: cross-process read-after-write verification — Node and Python
// workers write to shared chat IDs and immediately read back to verify
// WAL-mode consistency.
// ---------------------------------------------------------------------------
async function runCrossProcessVerifyStress() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazzap-db-xproc-'));
  const xprocIters = Math.min(iterations, 30);
  const xprocChats = Math.min(chatCount, 12);

  await initSchema(dataDir);

  const xprocNodeW = Math.min(nodeWorkers, 2);
  const xprocPythonW = Math.min(pythonWorkers, 2);

  const jobs = [];
  for (let i = 0; i < xprocNodeW; i += 1) {
    jobs.push(
      runChild(
        process.execPath,
        [workerPaths.xprocNode],
        stressEnv(dataDir, {
          WORKER_ID: String(i),
          STRESS_ITERATIONS: String(xprocIters),
          STRESS_CHAT_COUNT: String(xprocChats),
        }),
        `xproc-node-${i}`,
      ),
    );
  }
  for (let i = 0; i < xprocPythonW; i += 1) {
    jobs.push(
      runChild(
        pythonBin,
        [workerPaths.xprocPython],
        stressEnv(dataDir, {
          WORKER_ID: String(i + xprocNodeW),
          STRESS_ITERATIONS: String(xprocIters),
          STRESS_CHAT_COUNT: String(xprocChats),
        }),
        `xproc-python-${i}`,
      ),
    );
  }
  await Promise.all(jobs);
  verifySettingsOnly(dataDir);
  console.log('  cross-process verify stress test passed');
}

// ---------------------------------------------------------------------------
// New test: WAL sidecar cleanup — verify that no stale -wal/-shm files
// remain after clean shutdowns.
// ---------------------------------------------------------------------------
async function runWalCleanShutdownCheck() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazzap-db-wal-'));
  await initSchema(dataDir);

  // Run a single worker to write data, then verify no sidecar files after close
  await runChild(
    process.execPath,
    [workerPaths.node],
    stressEnv(dataDir, { WORKER_ID: '0', STRESS_ITERATIONS: '20' }),
    'wal-worker',
  );

  const paths = dbPaths(dataDir);
  for (const dbPath of Object.values(paths)) {
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    // After clean shutdown the WAL should be checkpointed, but a 0-byte wal
    // file might still exist (SQLite keeps it around in WAL mode). It should
    // NOT contain any large uncheckpointed data.
    try {
      const walStat = await fs.stat(walPath);
      // A WAL file larger than 1MB after clean shutdown is suspicious
      if (walStat.size > 1024 * 1024) {
        throw new Error(`${walPath} is ${walStat.size} bytes after clean shutdown — WAL not checkpointed`);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // No WAL file is fine
    }
    try {
      const shmStat = await fs.stat(shmPath);
      if (shmStat.size > 1024 * 1024) {
        throw new Error(`${shmPath} is ${shmStat.size} bytes after clean shutdown — SHM too large`);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  console.log('  WAL clean shutdown check passed');
}

// ===========================================================================
// Main test runner
// ===========================================================================
const dataDir = process.env.DB_STRESS_DATA_DIR || await fs.mkdtemp(path.join(os.tmpdir(), 'wazzap-db-stress-'));
await fs.mkdir(dataDir, { recursive: true });
console.log(`database stress data dir: ${dataDir}`);
console.log(`workers: node=${nodeWorkers} python=${pythonWorkers} iterations=${iterations} chats=${chatCount}`);

console.log('\n[1/6] basic concurrent read/write stress test');
await initSchema(dataDir);
await runConcurrentWorkers(dataDir);
verifyStressData(dataDir);

console.log('\n[2/6] corruption recovery stress test');
await runCorruptionRecoveryCheck();

console.log('\n[3/6] concurrent clearSettings stress test');
await runClearSettingsStress();

console.log('\n[4/6] concurrent init() stress test');
await runConcurrentInitStress();

console.log('\n[5/6] cross-process read-after-write stress test');
await runCrossProcessVerifyStress();

console.log('\n[6/6] WAL clean shutdown check');
await runWalCleanShutdownCheck();

console.log('\n✅ all database stress tests passed');