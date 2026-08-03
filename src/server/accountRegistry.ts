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
import path from 'path';
import type { AccountEntry, AccountContext, OutboundFrame } from '../protocol/types.js';
import logger from '../logger.js';

/**
 * Maximum number of queued reliable frames per account before the oldest is
 * dropped (1000) so per-account transports overflow identically.
 */
export const MAX_RELIABLE_QUEUE = 1000;

/** folderPath -> live account state. Module-private. */
const registry: Map<string, AccountEntry> = new Map();

/** Canonical configured tenant keys accepted by the WS handshake. */
const configuredAccounts: Set<string> = new Set();
const configuredAccountTokens: Map<string, string> = new Map();

/**
 * Accounts removed from the managed catalog during this process lifetime.
 * Their bridge may race one final reconnect before its hot-reload poll sees
 * the catalog change; the tombstone prevents that reconnect from recreating
 * the tenant after the operator removed it.
 */
const blockedAccounts: Set<string> = new Set();

function accountKey(folderPath: string): string {
  const normalized = path.resolve(folderPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** Replace the live WS tenant allowlist during gateway bootstrap. */
export function setConfiguredAccounts(
  accounts: Iterable<string | { folderPath: string; wsToken?: string | null }>,
): void {
  configuredAccounts.clear();
  configuredAccountTokens.clear();
  for (const account of accounts) {
    const folderPath = typeof account === 'string' ? account : account.folderPath;
    const key = accountKey(folderPath);
    configuredAccounts.add(key);
    if (typeof account !== 'string' && account.wsToken) {
      configuredAccountTokens.set(key, account.wsToken);
    }
  }
}

/** Allow a tenant added by the authenticated control panel. */
export function allowConfiguredAccount(
  account: string | { folderPath: string; wsToken?: string | null },
): void {
  const folderPath = typeof account === 'string' ? account : account.folderPath;
  const key = accountKey(folderPath);
  configuredAccounts.add(key);
  if (typeof account !== 'string' && account.wsToken) {
    configuredAccountTokens.set(key, account.wsToken);
  }
}

/** Return whether a client-supplied tenant path is configured for this gateway. */
export function isConfiguredAccount(folderPath: string): boolean {
  return configuredAccounts.has(accountKey(folderPath));
}

/** Return the per-account handshake credential, if this catalog has one. */
export function getConfiguredAccountToken(folderPath: string): string | undefined {
  return configuredAccountTokens.get(accountKey(folderPath));
}

/**
 * Return the existing entry for `folderPath`, creating a fresh one if absent.
 * Idempotent: repeated calls for the same `folderPath` return the same object.
 */
export function getOrCreate(folderPath: string): AccountEntry {
  const normalizedFolderPath = path.resolve(folderPath);
  const key = accountKey(normalizedFolderPath);
  let entry = registry.get(key);
  if (entry) return entry;
  entry = {
    // Keep the first caller's spelling for wire/log compatibility; the map
    // key above remains canonical, so aliases still resolve to this entry.
    folderPath,
    // Opaque placeholder until Step 16 defines AccountContext's real fields.
    ctx: {} as AccountContext,
    sock: undefined,
    client: undefined,
    waStatus: 'connecting',
    reliableQueue: [],
  };
  registry.set(key, entry);
  return entry;
}

/** Return the entry for `folderPath`, or undefined if none exists. */
export function get(folderPath: string): AccountEntry | undefined {
  return registry.get(accountKey(folderPath));
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

/**
 * Detach the bound client (e.g. on disconnect). Queued frames are retained.
 *
 * When `client` is provided, the entry is only cleared if that exact socket is
 * still the bound one. This prevents a late `close` event from an old socket
 * from clobbering a newer client that already reconnected and rebound during
 * the race window (which would silently divert all reliable frames to the
 * queue until the next reconnect).
 */
export function unbindClient(folderPath: string, client?: WebSocket): void {
  const entry = registry.get(accountKey(folderPath));
  if (!entry) return;
  if (client && entry.client !== client) return;
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
  registry.delete(accountKey(folderPath));
}

/** Temporarily reject a removed account's late bridge reconnects. */
export function block(folderPath: string): void {
  blockedAccounts.add(accountKey(folderPath));
}

/** Allow a newly-created/re-added account to bind again. */
export function unblock(folderPath: string): void {
  blockedAccounts.delete(accountKey(folderPath));
}

/** Return whether the account was removed during this process lifetime. */
export function isBlocked(folderPath: string): boolean {
  return blockedAccounts.has(accountKey(folderPath));
}

/** True when `client` is bound and its socket is OPEN. */
function clientIsOpen(client: WebSocket | undefined): client is WebSocket {
  return !!client && client.readyState === WebSocket.OPEN;
}

function sendRaw(client: WebSocket, frame: OutboundFrame): boolean {
  try {
    client.send(JSON.stringify(frame));
    return true;
  } catch (err) {
    logger.error({ err }, 'failed sending frame to account client');
    return false;
  }
}

function enqueueReliable(entry: AccountEntry, frame: OutboundFrame): void {
  entry.reliableQueue.push(frame);
  if (entry.reliableQueue.length > MAX_RELIABLE_QUEUE) {
    entry.reliableQueue.shift();
    logger.warn(
      { folderPath: entry.folderPath, queueSize: entry.reliableQueue.length },
      'reliable account queue overflow; oldest frame dropped',
    );
  }
}

/**
 * Best-effort send: deliver `frame` to the bound OPEN client, or silently drop
 * it if no client is bound / the client is not OPEN. Never enqueues.
 */
export function sendToClient(folderPath: string, frame: OutboundFrame): void {
  const entry = registry.get(accountKey(folderPath));
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
    if (sendRaw(entry.client, frame)) return;
    entry.client = undefined;
  }
  enqueueReliable(entry, frame);
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
  const entry = registry.get(accountKey(folderPath));
  if (!entry || !clientIsOpen(entry.client)) return;
  if (entry.reliableQueue.length === 0) return;
  const queued = entry.reliableQueue.splice(0, entry.reliableQueue.length);
  let sent = 0;
  for (let index = 0; index < queued.length; index += 1) {
    const frame = queued[index];
    if (!sendRaw(entry.client, frame)) {
      entry.client = undefined;
      entry.reliableQueue.unshift(...queued.slice(index));
      break;
    }
    sent += 1;
  }
  logger.info({ folderPath, count: sent }, 'flushed queued reliable frames to account client');
}
