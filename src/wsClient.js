/**
 * wsClient.js — WebSocket client for Node <-> Python communication.
 *
 * Two send modes:
 *   - send(message)     — best-effort, drops if disconnected. Used for
 *                         transient events like `incoming_message` (the next
 *                         burst will re-send newer state anyway).
 *   - sendReliable(msg)  — queues if disconnected, flushes on reconnect. Used
 *                         for state-sync events that must not be lost:
 *                         `whatsapp_status`, `clear_history`, `set_llm2_model`,
 *                         `invalidate_llm2_model`, `invalidate_default_model`,
 *                         `invalidate_chat_settings`, `set_subagent_enabled`.
 *
 * Reconnect strategy:
 *   Exponential backoff with symmetric jitter. Base delay is `WS_RECONNECT_MS`
 *   (default 5000), capped at `WS_RECONNECT_MAX_MS` (default 60000), with
 *   +/- `WS_RECONNECT_JITTER_RATIO` (default 0.2 = 20%) applied symmetrically
 *   so retries desynchronise across instances and avoid hammering a
 *   struggling server. The jittered result is also clamped to `maxMs` so a
 *   large jitter ratio can never exceed the configured cap. The pure function
 *   `computeReconnectDelay` is exported for deterministic unit testing.
 *
 *   To protect against "accept-then-kick" flaps (server 1xxx closes
 *   immediately after handshake) the `attempt` counter is NOT reset on the
 *   `'open'` event. Instead we arm a grace timer for
 *   `max(WS_RECONNECT_MS, 5000)`; only if the socket stays OPEN for that
 *   long is `attempt` reset to 0. A close before the grace expires leaves
 *   the counter intact so backoff keeps growing.
 *
 * Heartbeat:
 *   Canonical `ws` docs pattern (check-then-ping). On open we mark the
 *   socket alive; every pong re-marks it alive. A single interval timer
 *   fires every `WS_HEARTBEAT_INTERVAL_MS` (default 20000): if the socket
 *   was not marked alive since the previous tick, `ws.terminate()` is
 *   invoked, which triggers the normal `close` reconnect path. Otherwise
 *   the flag is cleared and a fresh ping is sent. Detection latency is
 *   exactly one interval and there is no second timer to race against.
 *   This is symmetrical with the Python side, which runs
 *   `websockets.serve(..., ping_interval=20, ping_timeout=20)` in
 *   `python/bridge/main.py` and would detect a dead Node the same way.
 *
 * Graceful shutdown:
 *   `close()` is async and returns a promise that resolves when the socket
 *   emits `'close'` or after a bounded 1000ms timeout, whichever comes
 *   first. It cancels the reconnect timer, clears heartbeat timers,
 *   best-effort flushes the reliable queue if the socket is still OPEN,
 *   drops whatever remains, and closes the socket. It does NOT strip
 *   listeners registered by external callers on the instance itself
 *   (e.g. `wsClient.on('message', ...)` in `src/index.js`); only the
 *   internal listeners on the underlying `ws` socket are removed.
 *   `src/index.js` awaits this in its SIGINT/SIGTERM handler before
 *   closing databases and calling `process.exit(0)`.
 *
 * The class is exported as a named export so tests can construct fresh
 * instances; the module's default export is a process-wide singleton used
 * by `src/index.js` and every `src/wa/command/*.js` caller.
 */
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import logger from './logger.js';
import config from './config.js';

/**
 * Pure function computing the next reconnect delay (in ms) for a given
 * attempt number using exponential backoff with symmetric jitter.
 *
 * Intended to be called for attempt >= 1 (attempt 0 is the initial connect
 * and should not be scheduled). For attempt <= 0 this returns 0.
 *
 * The jittered delay is clamped to `maxMs` so a large `jitterRatio` cannot
 * push the returned delay above the configured cap.
 *
 * @param {object} opts
 * @param {number} opts.attempt      Reconnect attempt number (1-indexed).
 * @param {number} opts.baseMs       Base delay for attempt 1 (e.g. 5000).
 * @param {number} opts.maxMs        Cap for the exponential growth and jittered result.
 * @param {number} opts.jitterRatio  [0,1] fraction of delay used for symmetric jitter.
 * @param {() => number} [opts.rand] Random source in [0,1). Injectable for tests.
 * @returns {number} Delay in ms, rounded, floored to 0, and capped at maxMs.
 */
export function computeReconnectDelay({ attempt, baseMs, maxMs, jitterRatio, rand = Math.random }) {
  if (!Number.isFinite(attempt) || attempt < 1) return 0;
  const exp = baseMs * Math.pow(2, attempt - 1);
  const delay = Math.min(maxMs, exp);
  const jitter = delay * jitterRatio * (rand() * 2 - 1);
  const jittered = Math.max(0, Math.round(delay + jitter));
  return Math.min(maxMs, jittered);
}

export class LLMWebSocket extends EventEmitter {
  /** Maximum number of queued reliable messages before dropping oldest. */
  static MAX_RELIABLE_QUEUE = 1000;

  constructor() {
    super();
    this.ws = null;
    this.reconnectTimer = null;
    this.reliableQueue = [];
    this.attempt = 0;
    this.heartbeatInterval = null;
    this.stableResetTimer = null;
    this.isAlive = false;
  }

  connect() {
    if (!config.wsEndpoint) {
      logger.error('LLM_WS_ENDPOINT is required');
      return;
    }

    // Clear any prior timers before opening a new socket so we never leak
    // timers across socket lifetimes.
    this._clearHeartbeat();

    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.close();
      } catch (err) {
        logger.warn({ err }, 'close previous ws failed');
      }
    }

    const headers = {};
    if (config.wsToken) {
      headers.Authorization = `Bearer ${config.wsToken}`;
    }

    logger.info({ endpoint: config.wsEndpoint, attempt: this.attempt }, 'connecting to LLM websocket');
    this.ws = new WebSocket(config.wsEndpoint, { headers });

    this.ws.on('open', () => {
      logger.info('LLM websocket connected');
      this.isAlive = true;
      this._startHeartbeat();
      // Reset attempt only after the socket has been OPEN for a grace
      // period; this prevents an immediate accept-then-kick flap from
      // perpetually masking backoff. Cancel in _clearHeartbeat (which is
      // invoked on close) and in close().
      const stableAfterMs = Math.max(config.wsReconnectIntervalMs, 5000);
      this.stableResetTimer = setTimeout(() => {
        this.attempt = 0;
        this.stableResetTimer = null;
      }, stableAfterMs);
      this.send({
        type: 'hello',
        payload: {
          instanceId: config.instanceId,
          role: 'whatsapp-gateway',
        },
      });
      this.flushReliableQueue();
      this.emit('connected');
    });

    this.ws.on('pong', () => {
      this.isAlive = true;
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.emit('message', msg);
      } catch (err) {
        logger.warn({ err }, 'failed parsing ws message');
      }
    });

    this.ws.on('close', (code, reason) => {
      logger.warn({ code, reason: reason?.toString() }, 'LLM websocket closed, scheduling reconnect');
      this._clearHeartbeat();
      this.emit('disconnected', { code, reason });
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      logger.error({ err }, 'LLM websocket error');
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.attempt += 1;
    const delay = computeReconnectDelay({
      attempt: this.attempt,
      baseMs: config.wsReconnectIntervalMs,
      maxMs: config.wsReconnectMaxMs,
      jitterRatio: config.wsReconnectJitterRatio,
    });
    logger.info({ attempt: this.attempt, delayMs: delay }, 'scheduling ws reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  _startHeartbeat() {
    this._clearHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.isAlive === false) {
        logger.warn({ intervalMs: config.wsHeartbeatIntervalMs }, 'ws heartbeat missed pong, terminating socket');
        try {
          this.ws.terminate();
        } catch (err) {
          logger.warn({ err }, 'ws terminate failed');
        }
        return;
      }
      this.isAlive = false;
      try {
        this.ws.ping();
      } catch (err) {
        logger.warn({ err }, 'ws ping failed');
      }
    }, config.wsHeartbeatIntervalMs);
  }

  _clearHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.stableResetTimer) {
      clearTimeout(this.stableResetTimer);
      this.stableResetTimer = null;
    }
  }

  async close() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._clearHeartbeat();
    // Best-effort: if the socket is still OPEN, flush queued reliable
    // messages before dropping anything.
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.reliableQueue.length > 0) {
      this.flushReliableQueue();
    }
    if (this.reliableQueue.length > 0) {
      logger.info({ dropped: this.reliableQueue.length }, 'ws close dropping queued reliable messages');
      this.reliableQueue.length = 0;
    }
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    // Drop only the listeners this class owns on the socket. External
    // listeners registered on the instance itself (e.g. `on('message', ...)`
    // in bootstrap) are left alone; the caller owns their own subscriptions.
    ws.removeAllListeners();
    if (ws.readyState === WebSocket.CLOSED) return;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 1000);
      if (typeof timer.unref === 'function') timer.unref();
      ws.once('close', finish);
      try {
        ws.close();
      } catch (err) {
        logger.warn({ err }, 'ws close failed');
        finish();
      }
    });
  }

  isConnected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  getAttempt() {
    return this.attempt;
  }

  getReliableQueueSize() {
    return this.reliableQueue.length;
  }

  send(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.debug('ws not ready, drop message');
      return;
    }
    this.sendRaw(message);
  }

  sendReliable(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendRaw(message);
      return;
    }
    this.reliableQueue.push(message);
    if (this.reliableQueue.length > LLMWebSocket.MAX_RELIABLE_QUEUE) {
      this.reliableQueue.shift();
      logger.warn({ queueSize: this.reliableQueue.length }, 'reliable ws queue overflow; oldest message dropped');
    }
    logger.debug({ queueSize: this.reliableQueue.length, type: message?.type }, 'ws not ready, queued reliable message');
  }

  flushReliableQueue() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.reliableQueue.length === 0) return;
    const queued = [...this.reliableQueue];
    this.reliableQueue.length = 0;
    for (const message of queued) {
      this.sendRaw(message);
    }
    logger.info({ count: queued.length }, 'flushed queued reliable ws messages');
  }

  sendRaw(message) {
    try {
      this.ws.send(JSON.stringify(message));
    } catch (err) {
      logger.error({ err }, 'failed sending ws message');
    }
  }
}

const wsClient = new LLMWebSocket();

export default wsClient;
