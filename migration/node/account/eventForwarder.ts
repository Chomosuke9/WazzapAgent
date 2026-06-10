/**
 * eventForwarder.ts — per-account Baileys→Python event forwarder (Step 18).
 *
 * This module is the single choke point that turns the two Baileys events the
 * Python bridge cares about — an inbound message and a connection-state change —
 * into the contract's `incoming_message` / `whatsapp_status` {@link OutboundFrame}s
 * and delivers them to the RIGHT Python client.
 *
 * Two responsibilities, nothing more (CONTRACT.md §1.4 / §1.1 / §7):
 *   - {@link forwardIncoming} stamps `payload.folderPath = entry.folderPath`
 *     (so §7's `folderPath` is now ALWAYS present on `incoming_message`) and
 *     sends best-effort.
 *   - {@link forwardStatus} normalizes the {@link WaStatus} (`closed→close`,
 *     CONTRACT.md §1.1) and sends reliably (queued if the client is unbound).
 *
 * Delivery topology:
 *   Both `incoming_message` and `whatsapp_status` are handed to the account
 *   registry (`accountRegistry.sendToClient` / `sendReliableToClient`), which
 *   delivers to the account's bound Python client (or drops/queues when none is
 *   bound). Routing both events through the registry guarantees EXACTLY-ONCE
 *   delivery (no double-send) and one consistent path for both events (Step 18)
 *   and control events (Step 21).
 *
 * Scope guard (per the step spec): this module does NOT handle actions
 * (Step 19), emit control events (Step 21), or run the WS server (Step 20).
 */
import config from '../config.js';
import * as registry from '../server/accountRegistry.js';
import type {
  AccountEntry,
  OutboundFrame,
  WaStatus,
  WhatsAppMessagePayload,
  WhatsAppStatusPayload,
} from '../protocol/types.js';

/**
 * Normalize a {@link WaStatus} to the contract's canonical set (CONTRACT.md
 * §1.1). The only wire-visible change is `"closed"→"close"`; `"open"` and
 * `"connecting"` pass through unchanged. Defensively accepts a raw string so
 * callers that haven't normalized yet (e.g. Baileys' raw `connection` value)
 * still produce a valid `WaStatus`.
 */
export function normalizeWaStatus(status: WaStatus | string): WaStatus {
  if (status === 'open') return 'open';
  if (status === 'close' || status === 'closed') return 'close';
  return 'connecting';
}

/**
 * Forward an inbound WhatsApp message to the account's Python client.
 *
 * Stamps `payload.folderPath` (CONTRACT.md §7 — now always present) and sends
 * the `incoming_message` frame BEST-EFFORT through the registry (dropped if no
 * client is open), the best-effort delivery semantics for transient inbound
 * payloads.
 */
export function forwardIncoming(entry: AccountEntry, payload: WhatsAppMessagePayload): void {
  payload.folderPath = entry.folderPath;
  const frame: OutboundFrame = { type: 'incoming_message', payload };
  registry.sendToClient(entry.folderPath, frame);
}

/**
 * Forward a connection-state change to the account's Python client.
 *
 * Normalizes the {@link WaStatus} (`closed→close`, CONTRACT.md §1.1) and sends
 * the `whatsapp_status` frame RELIABLY through the registry (queued and flushed
 * on (re)bind), the reliable delivery semantics for state-sync events.
 */
export function forwardStatus(entry: AccountEntry, status: WaStatus, reason?: number): void {
  const payload: WhatsAppStatusPayload = {
    folderPath: entry.folderPath,
    status: normalizeWaStatus(status),
    instanceId: config.instanceId,
  };
  if (typeof reason === 'number') payload.reason = reason;
  const frame: OutboundFrame = { type: 'whatsapp_status', payload };
  registry.sendReliableToClient(entry.folderPath, frame);
}

/** An {@link AccountEntry}-bound view of the forwarder used by listeners. */
export interface AccountForwarder {
  forwardIncoming(payload: WhatsAppMessagePayload): void;
  forwardStatus(status: WaStatus, reason?: number): void;
}

/**
 * Bind an {@link AccountEntry} to the forwarder so the Baileys
 * `messages.upsert` / `connection.update` listeners installed by
 * `baileysFactory` can forward without re-threading the entry on every call.
 */
export function bindForwarder(entry: AccountEntry): AccountForwarder {
  return {
    forwardIncoming: (payload) => forwardIncoming(entry, payload),
    forwardStatus: (status, reason) => forwardStatus(entry, status, reason),
  };
}
