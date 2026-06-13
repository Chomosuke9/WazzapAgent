/**
 * wsServer.ts — inbound WebSocket SERVER that accepts Python `WaSocket` clients
 * (Step 20).
 *
 * Instead of Node dialling out to a single Python server, Node LISTENS and each
 * Python client dials in, announces its tenant via the `hello` handshake (CONTRACT.md §1.1), and is then
 * bound to that account's live state in the {@link import('./accountRegistry.js')
 * registry}. Inbound action frames are routed to the per-account dispatcher;
 * outbound acks/events/control frames flow back through the registry (wired by
 * the dispatcher and the Baileys event listeners installed by the factory).
 *
 * Strict delegation (per the step spec) — this module contains NONE of:
 *   - Baileys socket creation — delegated to
 *     `baileysFactory.createOrResumeAccount` (Step 17), which also ensures the
 *     tenant folder layout (CONTRACT.md §8) on first `hello`.
 *   - Action handling — delegated to `actionDispatcher.dispatchAction` (Step 19).
 *   - Event normalization — the Baileys→Python `incoming_message` /
 *     `whatsapp_status` frames are produced by `eventForwarder` (Step 18) from
 *     listeners the factory attaches; this module never touches them inline.
 *
 * Lifecycle per connection:
 *   1. (optional) `Authorization: Bearer <LLM_WS_TOKEN>` check during the HTTP
 *      upgrade. Rejected with `401` when a token is configured and the header is
 *      missing/invalid; skipped entirely when no token is configured.
 *   2. First frame MUST be `type: "hello"` carrying `payload.folderPath`. We
 *      `createOrResumeAccount({ folderPath })`, send `hello_ack`, bind the
 *      client, and flush its queued reliable frames.
 *   3. Subsequent frames are routed to `dispatchAction(entry, frame)`.
 *   4. On `close` we ONLY `unbindClient(folderPath)` — the Baileys socket stays
 *      alive so the account remains connected to WhatsApp; reliable control
 *      events queue on the registry until the client returns.
 *
 * Heartbeat: the canonical `ws` server `isAlive` ping/terminate pattern — a
 * single interval at `WS_HEARTBEAT_INTERVAL_MS` pings every client and
 * terminates any that did not pong since the previous tick. Detection latency
 * is exactly one interval.
 *
 * NOTE: built behind a SECONDARY entry. The live boot (`index.ts`) is NOT wired
 * to this server here; that atomic flip is Step 28.
 */
import WebSocket, { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import { timingSafeEqual } from 'crypto';
import logger from '../logger.js';
import config from '../config.js';
import * as registry from './accountRegistry.js';
import { createOrResumeAccount } from '../account/baileysFactory.js';
import { dispatchAction } from '../account/actionDispatcher.js';
import type {
  InboundFrame,
  HelloPayload,
  OutboundFrame,
} from '../protocol/types.js';

/**
 * Per-connection bookkeeping layered onto the raw `ws` socket: the heartbeat
 * liveness flag and the bound tenant key (set once the handshake completes).
 */
interface ServerClient extends WebSocket {
  isAlive?: boolean;
  folderPath?: string;
  helloDone?: boolean;
}

/** True when `header` is a valid `Bearer <token>` for the configured token. */
function authorizeUpgrade(req: IncomingMessage): boolean {
  const token = config.wsToken;
  // No token configured -> auth is disabled, accept every client.
  if (!token) return true;
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return false;
  // Constant-time comparison so a network attacker cannot use response-timing
  // differences to recover the token byte-by-byte. Length is compared first
  // (timingSafeEqual throws on length mismatch); the length itself is not
  // secret, so an early length-based return is acceptable.
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Start the inbound WS server.
 *
 * @param port Listening port; defaults to {@link config.wsListenPort}
 *   (env `WS_LISTEN_PORT`, default 3000). Pass `0` for an ephemeral port (tests).
 * @returns the live {@link WebSocketServer}.
 */
export function startWsServer(port: number = config.wsListenPort): WebSocketServer {
  const wss = new WebSocketServer({
    port,
    // Bind to the configured host (loopback by default) so the gateway control
    // plane is not exposed on all interfaces unless explicitly opted in.
    host: config.wsBindHost,
    // Reject oversized frames at the protocol layer (DoS hardening).
    maxPayload: config.wsMaxPayloadBytes,
    // Bearer-token auth at the HTTP upgrade so an unauthorized client is
    // rejected with 401 and never reaches the `connection` handler.
    verifyClient: (
      info: { origin: string; secure: boolean; req: IncomingMessage },
      cb: (res: boolean, code?: number, message?: string) => void,
    ) => {
      if (authorizeUpgrade(info.req)) {
        cb(true);
        return;
      }
      logger.warn('rejecting ws client: missing/invalid Authorization');
      cb(false, 401, 'Unauthorized');
    },
  });

  wss.on('listening', () => {
    const addr = wss.address();
    const boundPort = typeof addr === 'object' && addr ? addr.port : port;
    logger.info({ port: boundPort, host: config.wsBindHost }, 'ws server listening');
    // Loud warning if the control plane is reachable off-box without a token.
    const isLoopback = config.wsBindHost === '127.0.0.1' || config.wsBindHost === '::1' || config.wsBindHost === 'localhost';
    if (!isLoopback && !config.wsToken) {
      logger.warn(
        { host: config.wsBindHost },
        'SECURITY: ws server bound to a non-loopback host without LLM_WS_TOKEN — ' +
          'the WhatsApp control plane is exposed unauthenticated. Set LLM_WS_TOKEN.',
      );
    }
  });

  wss.on('connection', (rawWs: WebSocket) => {
    const ws = rawWs as ServerClient;
    ws.isAlive = true;
    ws.helloDone = false;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data: WebSocket.RawData) => {
      let frame: InboundFrame;
      try {
        frame = JSON.parse(data.toString()) as InboundFrame;
      } catch (err) {
        logger.warn({ err }, 'failed parsing inbound ws frame');
        return;
      }

      if (!ws.helloDone) {
        void handleHello(ws, frame);
        return;
      }

      const folderPath = ws.folderPath as string;
      const entry = registry.get(folderPath);
      if (!entry) {
        logger.error({ folderPath, type: (frame as { type?: string }).type }, 'no account entry for bound client; dropping frame');
        return;
      }
      // Delegate ALL action handling (acks/errors routed back via registry).
      void dispatchAction(entry, frame as never);
    });

    ws.on('close', () => {
      // Keep the Baileys socket ALIVE: only detach the Python client. Reliable
      // control events queue on the registry until the client reconnects.
      // Pass `ws` so a late close from a stale socket cannot unbind a client
      // that already reconnected and rebound during the race window.
      if (ws.folderPath) {
        registry.unbindClient(ws.folderPath, ws);
        logger.info({ folderPath: ws.folderPath }, 'ws client disconnected; account kept connected');
      }
    });

    ws.on('error', (err: Error) => {
      logger.error({ err }, 'ws server connection error');
    });
  });

  // Canonical `ws` server heartbeat: one interval pings every client and
  // terminates any that missed the previous pong.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const sc = client as ServerClient;
      if (sc.readyState !== WebSocket.OPEN) continue;
      if (sc.isAlive === false) {
        logger.warn({ folderPath: sc.folderPath }, 'ws client missed pong, terminating');
        try {
          sc.terminate();
        } catch (err) {
          logger.warn({ err }, 'ws terminate failed');
        }
        continue;
      }
      sc.isAlive = false;
      try {
        sc.ping();
      } catch (err) {
        logger.warn({ err }, 'ws ping failed');
      }
    }
  }, config.wsHeartbeatIntervalMs);
  // Don't let the heartbeat timer keep the event loop alive on its own.
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  wss.on('close', () => {
    clearInterval(heartbeat);
  });

  return wss;
}

/**
 * Complete the `hello` handshake for a freshly connected client: validate the
 * frame, create/resume the tenant account, ACK, then bind + flush.
 *
 * Ordering note: `hello_ack` is sent BEFORE `registry.bindClient`. `bindClient`
 * flushes the account's reliable queue on bind, so sending the ack first
 * guarantees any queued control events are delivered AFTER the handshake
 * completes (CONTRACT.md §1.1).
 */
async function handleHello(ws: ServerClient, frame: InboundFrame): Promise<void> {
  if (frame?.type !== 'hello') {
    logger.warn({ type: (frame as { type?: string })?.type }, 'first frame was not hello; closing');
    try {
      ws.close(1002, 'expected hello');
    } catch {
      /* socket may already be closing */
    }
    return;
  }

  const payload = (frame as { payload?: HelloPayload }).payload;
  const folderPath = payload?.folderPath;
  if (!folderPath || typeof folderPath !== 'string') {
    logger.warn('hello missing folderPath; closing');
    try {
      ws.close(1002, 'hello missing folderPath');
    } catch {
      /* socket may already be closing */
    }
    return;
  }

  try {
    // Delegated: account/socket creation + tenant folder layout (CONTRACT.md §8).
    const entry = await createOrResumeAccount({ folderPath });
    ws.folderPath = folderPath;
    ws.helloDone = true;

    // hello_ack BEFORE bind so it precedes any queued reliable frames that the
    // subsequent bindClient/flush delivers.
    const ack: OutboundFrame = {
      type: 'hello_ack',
      payload: { folderPath, waStatus: entry.waStatus },
    };
    try {
      ws.send(JSON.stringify(ack));
    } catch (err) {
      logger.error({ err, folderPath }, 'failed sending hello_ack');
    }

    registry.bindClient(folderPath, ws);
    // Explicit per the contract; a no-op after bindClient already flushed.
    registry.flushReliableQueue(folderPath);
  } catch (err) {
    logger.error({ err, folderPath }, 'handshake failed');
    try {
      ws.close(1011, 'handshake failed');
    } catch {
      /* socket may already be closing */
    }
  }
}
