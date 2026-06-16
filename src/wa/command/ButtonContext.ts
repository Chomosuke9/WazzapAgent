import type { WASocket, WAMessage } from "baileys";
import type { ParticipantRoleFlags, GroupContextValue } from "../domain/caches.js";
import type { AccountContext } from "../../account/accountContext.js";

// ---------------------------------------------------------------------------
// ButtonContext + ButtonHandler descriptor
// ---------------------------------------------------------------------------
//
// Button taps (interactive button / list / native-flow / template replies)
// mirror slash commands: each handler is an auto-discovered descriptor that
// declares the `selectedId` prefixes it owns plus an optional declarative
// permission / activation requirement. `ButtonRegistry` builds one
// `Map<prefix, handler>` from the descriptors and enforces the gates centrally
// (mirrors `CommandRegistry` / `CommandHandler`).

/**
 * The once-derived context handed to every button handler's `run`. Computed
 * once by `handleButtonResponse` (connection.ts) and threaded through
 * `dispatchButton`; `msg` is included so handlers that reconstruct a command
 * context (e.g. the `/`-slash button) keep the original key / pushName.
 */
export interface ButtonContext {
  sock: WASocket;
  account: AccountContext;
  msg: WAMessage;
  chatId: string;
  senderId: string;
  isGroup: boolean;
  group: GroupContextValue | null;
  senderRole: ParticipantRoleFlags;
  senderIsAdmin: boolean;
  senderIsOwner: boolean;
}

/**
 * A single button handler, auto-discovered from `src/wa/commands/`.
 *
 * `prefixes` lists every `selectedId` prefix that resolves to this handler;
 * the registry strips the matched (longest) prefix and passes the remainder as
 * `payload`. `permission` is a boolean expression over the shared permission
 * atoms (default `"public"`); `requireActivation` defaults to `true` and, when
 * left default, gates the tap behind the chat's activation state exactly like
 * the old inline button handlers. Set it `false` for handlers that delegate to
 * a path performing its OWN activation gate (e.g. the `/`-slash button).
 */
export interface ButtonHandler {
  prefixes: string[];
  permission?: string;
  requireActivation?: boolean;
  run(bc: ButtonContext, payload: string): Promise<void> | void;
}
