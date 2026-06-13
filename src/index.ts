/**
 * index.ts — live boot entry (Step 28: WS topology flip).
 *
 * Before this step Node dialled OUT to the Python WS server
 * (`startWhatsApp()` + a single outbound WS client) and routed inbound action
 * frames through an in-file `dispatchCommand` copy. After the flip Node is the WS
 * SERVER: each Python `WaSocket` client dials in, announces its tenant via the
 * `hello` handshake, and the per-account `actionDispatcher` (wired through
 * `wsServer`/`accountRegistry`) owns ALL action routing + ack/error emission.
 *
 * `index.ts` is now the thin entry: initialise the DBs, start the WS server on
 * `WS_LISTEN_PORT`, and handle shutdown signals. Node no longer dials out — the
 * canonical action dispatcher lives in `account/actionDispatcher.ts` and Baileys
 * sockets are created on `hello` by `account/baileysFactory.ts`.
 */
import logger from './logger.js';
import config from './config.js';
import * as registry from './server/accountRegistry.js';
import {
  ensureFolderLayout,
  openAccountPersistence,
} from './account/baileysFactory.js';
import { startWsServer } from './server/wsServer.js';
import type { WebSocketServer } from 'ws';

let wss: WebSocketServer | undefined;

/** Close every live account's Database (Step 05: persistence is per-tenant). */
function closeAllAccountDbs(): void {
  for (const entry of registry.list()) {
    try {
      entry.database?.close();
    } catch (err) {
      logger.error({ err, folderPath: entry.folderPath }, 'failed closing account db');
    }
  }
}

async function bootstrap(): Promise<void> {
  // Boot the default tenant (config.dataDir): create its AccountEntry and open
  // its per-tenant Database under `<dataDir>/db` so the single-account default
  // works exactly as before from the user's perspective. The Baileys socket is
  // still created lazily on the Python client's `hello` (createOrResumeAccount
  // reuses this already-open Database).
  const defaultEntry = registry.getOrCreate(config.dataDir);
  const layout = ensureFolderLayout(config.dataDir);
  openAccountPersistence(defaultEntry, layout.dbDir);

  // Start the inbound WS server. Each Python WaSocket client connects here and
  // is bound to its tenant account by the server's `hello` handshake; action
  // routing is delegated to `account/actionDispatcher.ts`.
  wss = startWsServer(config.wsListenPort);
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  try {
    if (wss) {
      // `WebSocketServer.close()` only invokes its callback once every client
      // connection has ended. The Python bridge normally stays connected, so
      // we must terminate live clients first, and additionally race a timeout
      // so a stuck socket can never block shutdown (which would leave the DB
      // WAL uncheckpointed). DB close happens unconditionally below.
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch (err) {
          logger.warn({ err }, 'failed terminating ws client during shutdown');
        }
      }
      await Promise.race([
        new Promise<void>((resolve) => {
          wss!.close(() => resolve());
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
  } catch (err) {
    logger.error({ err }, 'ws server close failed during shutdown');
  } finally {
    closeAllAccountDbs();
  }
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown(signal).catch((err) => logger.error({ err }, 'shutdown error'));
  });
}

bootstrap().catch((err) => {
  logger.error({ err }, 'bootstrap failed');
  closeAllAccountDbs();
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandledRejection');
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaughtException');
});
