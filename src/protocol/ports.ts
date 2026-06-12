// src/protocol/ports.ts
//
// Layering seam (Step 07). `account/` owns the Baileys socket + the per-account
// event forwarder; `wa/` owns the WhatsApp message/command logic. Historically
// the two packages imported each other (worked around with lazy `await
// import()`), forming an `account/ ↔ wa/` cycle.
//
// This module breaks that cycle by declaring the INTERFACES that cross the
// boundary, in the lowest layer (`protocol/`, which everyone may import):
//
//   - `WaSocketLike` — the subset of the Baileys `WASocket` surface the gateway
//     actually uses. `wa/*` helpers and the per-account holders depend on this
//     instead of `sock: any`, and `account/` assigns the concrete `WASocket`
//     (which is structurally assignable to it).
//   - `AccountForwarder` — what `wa/` needs FROM `account/` to push Baileys
//     events to the Python client. `wa/events.ts` / `wa/inbound.ts` reach it via
//     `AccountContext.forwarder` instead of statically importing
//     `account/eventForwarder.ts`, so `wa/` no longer imports `account/`.
//
// TYPES ONLY — this module emits nothing at runtime.

import type { WASocket } from "baileys";
import type { WaStatus, WhatsAppMessagePayload } from "./types.js";

/**
 * The subset of the Baileys {@link WASocket} surface the gateway actually
 * invokes (derived from real usage across `src/`). Deliberately narrow — only
 * the members called anywhere on a `sock` value — so the socket is typed at
 * every boundary without re-stating the whole (large) Baileys socket type. A
 * concrete `WASocket` is structurally assignable to this, so `account/` can
 * keep handing the real socket to `wa/*` helpers typed against it.
 */
export type WaSocketLike = Pick<
  WASocket,
  | "sendMessage"
  | "relayMessage"
  | "sendPresenceUpdate"
  | "readMessages"
  | "groupMetadata"
  | "groupParticipantsUpdate"
  | "groupFetchAllParticipating"
  | "groupAcceptInvite"
  | "waUploadToServer"
  | "user"
  | "ev"
>;

/**
 * The account-side event sink `wa/` uses to forward Baileys events to the
 * bound Python client. Implemented by `account/eventForwarder.ts`
 * (`bindForwarder`) and exposed to `wa/*` via {@link
 * import('../account/accountContext.js').AccountContext.forwarder}, so the
 * forwarding edge (`wa/ → account/`) is satisfied through this interface rather
 * than a concrete import (no `account/ ↔ wa/` cycle).
 */
export interface AccountForwarder {
  /** Forward a normalized inbound payload (best-effort `incoming_message`). */
  forwardIncoming(payload: WhatsAppMessagePayload): void;
  /** Forward a normalized connection-state change (reliable `whatsapp_status`). */
  forwardStatus(status: WaStatus, reason?: number): void;
}
