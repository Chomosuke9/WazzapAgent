/**
 * accountRegistry.ts — in-memory registry of live per-account state.
 *
 * The multi-account server maps each `folderPath` (the tenant key) to an
 * {@link AccountEntry}: its Baileys socket (Step 17), the bound Python
 * {@link WebSocket} client (when connected), the opaque per-account state
 * context (Step 16), the normalized WhatsApp status, and a per-account
 * reliable-event queue.
 *
 * This is a LEAF module: it owns nothing but the `Map` and the per-account
 * send helpers. It does NOT create Baileys sockets, start a `ws.Server`,
 * dispatch actions, or define `AccountContext`'s real fields — those live in
 * later steps. Nothing wires this into the live boot yet.
 *
 * Reliable-queue semantics:
 *   - {@link sendToClient} is best-effort — it drops the frame if no client is
 *     bound or the bound client is not OPEN (transient events like
 *     `incoming_message`).
 *   - {@link sendReliableToClient} sends immediately when a client is bound and
 *     OPEN, otherwise it enqueues the frame onto the account's `reliableQueue`,
 *     dropping the oldest entry once the queue exceeds {@link MAX_RELIABLE_QUEUE}
 *     (bound — 1000).
 *   - {@link flushReliableQueue} drains the queue in order on (re)bind.
 */
import WebSocket from 'ws';
import type { AccountEntry, AccountContext, OutboundFrame } from '../protocol/types.js';
import logger from '../logger.js';

/**
 * Maximum number of queued reliable frames per account before the oldest is
 * dropped (1000) so per-account transports overflow identically.
 */
export const MAX_RELIABLE_QUEUE = 1000;

/** folderPath -> live account state. Module-private. */
const registry: Map<string, AccountEntry> = new Map();

/**
 * Return the existing entry for `folderPath`, creating a fresh one if absent.
 * Idempotent: repeated calls for the same `folderPath` return the same object.
 */
export function getOrCreate(folderPath: string): AccountEntry {
  let entry = registry.get(folderPath);
  if (entry) return entry;
  entry = {
    folderPath,
    // Opaque placeholder until Step 16 defines AccountContext's real fields.
    ctx: {} as AccountContext,
    sock: undefined,
    client: undefined,
    waStatus: 'connecting',
    reliableQueue: [],
  };
  registry.set(folderPath, entry);
  return entry;
}

/** Return the entry for `folderPath`, or undefined if none exists. */
export function get(folderPath: string): AccountEntry | undefined {
  return registry.get(folderPath);
}

/**
 * Bind a Python {@link WebSocket} client to the account and immediately drain
 * any reliable frames queued while no client was bound.
 */
export function bindClient(folderPath: string, client: WebSocket): void {
  const entry = getOrCreate(folderPath);
  entry.client = client;
  flushReliableQueue(folderPath);
}

/** Detach the bound client (e.g. on disconnect). Queued frames are retained. */
export function unbindClient(folderPath: string): void {
  const entry = registry.get(folderPath);
  if (!entry) return;
  entry.client = undefined;
}

/**
 * Attach the live Baileys socket to the account. The socket itself is created
 * elsewhere (Step 17); this only stores the reference.
 */
export function bindSock(folderPath: string, sock: AccountEntry['sock']): void {
  const entry = getOrCreate(folderPath);
  entry.sock = sock;
}

/** Return a snapshot array of all current entries. */
export function list(): AccountEntry[] {
  return [...registry.values()];
}

/** Remove the account entry entirely (dropping any queued reliable frames). */
export function remove(folderPath: string): void {
  registry.delete(folderPath);
}

/** True when `client` is bound and its socket is OPEN. */
function clientIsOpen(client: WebSocket | undefined): client is WebSocket {
  return !!client && client.readyState === WebSocket.OPEN;
}

function sendRaw(client: WebSocket, frame: OutboundFrame): void {
  try {
    client.send(JSON.stringify(frame));
  } catch (err) {
    logger.error({ err }, 'failed sending frame to account client');
  }
}

/**
 * Best-effort send: deliver `frame` to the bound OPEN client, or silently drop
 * it if no client is bound / the client is not OPEN. Never enqueues.
 */
export function sendToClient(folderPath: string, frame: OutboundFrame): void {
  const entry = registry.get(folderPath);
  if (!entry || !clientIsOpen(entry.client)) {
    logger.debug({ folderPath, type: frame?.type }, 'no open client, dropping best-effort frame');
    return;
  }
  sendRaw(entry.client, frame);
}

/**
 * Reliable send: deliver `frame` immediately when a client is bound and OPEN,
 * otherwise enqueue it onto the account's `reliableQueue`. The queue is bounded
 * to {@link MAX_RELIABLE_QUEUE}; once exceeded the oldest frame is dropped.
 */
export function sendReliableToClient(folderPath: string, frame: OutboundFrame): void {
  const entry = getOrCreate(folderPath);
  if (clientIsOpen(entry.client)) {
    sendRaw(entry.client, frame);
    return;
  }
  entry.reliableQueue.push(frame);
  if (entry.reliableQueue.length > MAX_RELIABLE_QUEUE) {
    entry.reliableQueue.shift();
    logger.warn(
      { folderPath, queueSize: entry.reliableQueue.length },
      'reliable account queue overflow; oldest frame dropped',
    );
  }
  logger.debug(
    { folderPath, queueSize: entry.reliableQueue.length, type: frame?.type },
    'no open client, queued reliable frame',
  );
}

/**
 * Drain the account's reliable queue in FIFO order to the bound OPEN client.
 * No-op if no entry exists, the client is not OPEN, or the queue is empty.
 */
export function flushReliableQueue(folderPath: string): void {
  const entry = registry.get(folderPath);
  if (!entry || !clientIsOpen(entry.client)) return;
  if (entry.reliableQueue.length === 0) return;
  const queued = entry.reliableQueue.splice(0, entry.reliableQueue.length);
  for (const frame of queued) {
    sendRaw(entry.client, frame);
  }
  logger.info({ folderPath, count: queued.length }, 'flushed queued reliable frames to account client');
}
