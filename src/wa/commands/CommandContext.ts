import type { WAMessage } from "baileys";
import type { ParticipantRoleFlags, GroupContextValue } from "../domain/caches.js";
import type { AccountContext } from "../../account/accountContext.js";
import type { AccountRepositories } from "../../db/repositories/index.js";
import type { WaSocketLike } from "../../protocol/ports.js";

// ---------------------------------------------------------------------------
// Strict command-handler context
// ---------------------------------------------------------------------------

// The fully-resolved context passed to every command handler's `run`. Unlike
// the previous all-optional shape with an index signature, this is a strict
// type: the dispatcher (`dispatchCommand` in CommandRegistry) constructs one
// concrete object with every field populated, so handlers destructure exactly
// the fields they need with compile-time safety (no `as CommandContext` casts).
//
// Genuinely-nullable fields are typed `| null`; `account` and `repos` are
// optional because handlers historically guard them (`account?.`, `repos!.`)
// and the holder on `AccountContext` is itself populated lazily by the factory.
export interface CommandContext {
  /** Target chat JID. */
  chatId: string;
  /** `"group"` | `"private"`. */
  chatType: string;
  /** Acting sender JID (the bot's own JID on self-triggered commands). */
  senderId: string;
  /** Sender is a group admin/superadmin. */
  senderIsAdmin: boolean;
  /** Sender is a configured bot owner. */
  senderIsOwner: boolean;
  /** Bot itself is a group admin. */
  botIsAdmin: boolean;
  /** Argument string (everything after the command token). */
  args: string;
  /**
   * Free-form text payload. Mirrors `args` for the dispatch path (kept so
   * `/broadcast` can read `text`). Behaviorally identical to the previous
   * switch, which passed `text: args` for broadcast.
   */
  text: string;
  /** Anchor contextMsgId / message id, when present. */
  contextMsgId: string | null;
  /** Stanza id of the quoted message, resolved from the message contextInfo. */
  quotedMessageId: string | null;
  /** Sender display name (pushName), `""` when unknown. */
  senderDisplay: string;
  /** Sender role flags within the group, `null` in private chats. */
  senderRole: ParticipantRoleFlags | null;
  /** `chatType === "group"`. */
  isGroup: boolean;
  /** Whether the underlying message was sent by the bot. */
  fromMe: boolean;
  /** Cached group context, `null` in private chats. */
  group: GroupContextValue | null;
  /** The originating (or synthesized) WhatsApp message. */
  msg: WAMessage;
  /** Acting account's per-tenant state holder. */
  account?: AccountContext;
  /** Acting account's tenant key (folderPath). */
  folderPath: string;
  /** Acting account's live Baileys socket (Step 07: typed to the used surface). */
  sock: WaSocketLike;
  /** Acting account's repository bundle (per-tenant DBs). */
  repos?: AccountRepositories;
}

// ---------------------------------------------------------------------------
// CommandHandler descriptor
// ---------------------------------------------------------------------------

export type CommandPermission = "owner";

/**
 * A single slash command. `name` is the canonical token reported to the bridge;
 * `aliases` are the additional tokens that resolve to it (single source of
 * truth — no parallel alias table). `permission: "owner"` reproduces the old
 * inline owner-gate: the dispatcher replies with the standard rejection and
 * skips `run` for non-owners.
 */
export interface CommandHandler {
  name: string;
  aliases?: string[];
  permission?: CommandPermission;
  run(ctx: CommandContext): Promise<void>;
}
