// ---------------------------------------------------------------------------
// Typed command registry + dispatch
// ---------------------------------------------------------------------------
//
// Single source of truth for Node-side slash commands. Each command is a
// `CommandHandler` descriptor that declares its own canonical name, aliases,
// and optional permission. The registry builds one `Map<token, handler>` from
// the descriptors (name + every alias), so adding a command means adding one
// handler file and registering its descriptor here — no parallel alias table
// and no dispatch switch to keep in sync.
//
// `parseSlashCommand` resolves a raw `/token` to its canonical command name via
// the same map, preserving the previous contract (canonical name on hit, `null`
// on an unknown command) that callers like `inbound.ts` rely on for the wire
// payload's `slashCommand`/`commandHandled` fields.

import { unwrapMessage, extractContextInfo } from "../domain/messageParser.js";
import config from "../../config.js";
import { parseRawSlash } from "../command/parseCommand.js";
import { isActivationRequired } from "../botConfig.js";
import type { proto, WAMessage } from "baileys";
import type { ParticipantRoleFlags, GroupContextValue } from "../domain/caches.js";
import type { AccountContext } from "../../account/accountContext.js";
import type { AccountRepositories } from "../../db/repositories/index.js";
import type { CommandContext, CommandHandler } from "./CommandContext.js";
import type { WaSocketLike } from "../../protocol/ports.js";

import { helpCommand } from "../command/help.js";
import { activateCommand } from "../command/activate.js";
import { generateCommand } from "../command/generate.js";
import { monitorCommand } from "../command/monitor.js";
import { revokeCommand } from "../command/revoke.js";
import { promptCommand } from "../command/prompt.js";
import { resetCommand } from "../command/reset.js";
import { permissionCommand } from "../command/permission.js";
import { modeCommand } from "../command/mode.js";
import { triggerCommand } from "../command/trigger.js";
import { dashboardCommand } from "../command/dashboard.js";
import { broadcastCommand } from "../command/broadcast.js";
import { infoCommand } from "../command/info.js";
import { debugCommand } from "../command/debug.js";
import { joinCommand } from "../command/join.js";
import { stickerCommand } from "../command/sticker.js";
import { addStickerCommand } from "../command/addsticker.js";
import { removeStickerCommand } from "../command/removesticker.js";
import { modelcfgCommand } from "../command/modelcfg.js";
import { settingCommand } from "../command/setting.js";
import { groupStatusCommand } from "../command/groupStatus.js";
import { catchCommand } from "../command/catch.js";
import { ownerContactCommand } from "../command/ownerContact.js";
import { subagentCommand } from "../command/subagent.js";
import { idleCommand } from "../command/idle.js";
import { announcementCommand } from "../command/announcement.js";
import { botConfCommand } from "../command/bot-conf.js";

const ALL_COMMANDS: CommandHandler[] = [
  helpCommand,
  activateCommand,
  generateCommand,
  monitorCommand,
  revokeCommand,
  promptCommand,
  resetCommand,
  permissionCommand,
  modeCommand,
  triggerCommand,
  dashboardCommand,
  broadcastCommand,
  infoCommand,
  debugCommand,
  joinCommand,
  stickerCommand,
  addStickerCommand,
  removeStickerCommand,
  modelcfgCommand,
  settingCommand,
  groupStatusCommand,
  catchCommand,
  ownerContactCommand,
  subagentCommand,
  idleCommand,
  announcementCommand,
  botConfCommand,
];

/**
 * Token → handler map. Keyed by each command's canonical name and every alias.
 * Duplicate tokens are a programming error and throw at module load.
 */
const commandRegistry: Map<string, CommandHandler> = (() => {
  const map = new Map<string, CommandHandler>();
  for (const handler of ALL_COMMANDS) {
    const tokens = [handler.name, ...(handler.aliases ?? [])];
    for (const token of tokens) {
      if (map.has(token)) {
        throw new Error(`Duplicate command token registered: ${token}`);
      }
      map.set(token, handler);
    }
  }
  return map;
})();

/** Resolve a raw (lowercased) command token to its handler, if known. */
function getCommand(token: string): CommandHandler | undefined {
  return commandRegistry.get(token);
}

// ---------------------------------------------------------------------------
// Parsing (canonical resolution)
// ---------------------------------------------------------------------------

/**
 * Parse a slash command and resolve it to its canonical name. Returns `null`
 * for non-slash text and for unknown commands — preserving the previous
 * `parseSlashCommand` contract that `inbound.ts` uses for the wire payload.
 */
function parseSlashCommand(
  text: string | null,
): { command: string; args: string } | null {
  const raw = parseRawSlash(text);
  if (!raw) return null;
  const handler = getCommand(raw.command);
  if (!handler) return null;
  return { command: handler.name, args: raw.args };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

// The message object handed to the dispatcher. The real `messages.upsert` path
// passes a Baileys `WAMessage`; the button-click and `run_command` paths
// synthesize a minimal compatible shape. Both are accepted here so callers keep
// type-checking without changes.
type ListenerMessage = {
  key: proto.IMessageKey;
  message?: proto.IMessage | Record<string, unknown> | null;
  pushName?: string | null;
  quotedStanzaId?: string | null;
};

// Shape of the loose `context` object that the dispatch sites (connection.ts /
// runCommand.ts / baileysFactory.ts) build for each slash command. The
// dispatcher narrows it into a strict {@link CommandContext} before invoking a
// handler.
export interface CommandListenerContext {
  slashCommand: { command: string; args: string } | null;
  chatId: string;
  chatType: string;
  senderId: string;
  senderIsAdmin: boolean;
  senderIsOwner: boolean;
  botIsAdmin: boolean;
  botIsSuperAdmin?: boolean;
  contextMsgId?: string | null;
  fromMe?: boolean;
  text?: string;
  senderDisplay?: string;
  senderRole?: ParticipantRoleFlags | null;
  group?: GroupContextValue | null;
  account?: AccountContext;
  folderPath?: string;
  repos?: AccountRepositories;
  sock?: WaSocketLike;
}

// Commands allowed before a chat is activated (when REQUIRE_ACTIVATION=true).
const ACTIVATION_EXEMPT_COMMANDS = new Set(["info", "activate"]);

/**
 * Dispatch a parsed slash command. Performs the activation gate and the
 * per-command owner gate, then runs the resolved handler with a strict context.
 *
 * @returns `true` when the command was recognised and handled (so the caller
 *   suppresses normal message processing), `false` otherwise.
 */
async function dispatchCommand(
  msg: ListenerMessage,
  context: CommandListenerContext,
): Promise<boolean> {
  const {
    slashCommand,
    chatId,
    chatType,
    senderIsAdmin,
    senderId,
    botIsAdmin,
    senderIsOwner,
    contextMsgId,
    fromMe,
  } = context;

  if (!slashCommand) return false;

  const { command, args } = slashCommand;

  // Unknown command → no-op (mirrors the old switch `default`). Resolved before
  // the activation gate so an unrecognised token never triggers activation
  // side effects.
  const handler = getCommand(command);
  if (!handler) return false;

  // The acting account's tenant key, resolved from the threaded context with a
  // fallback to the DEFAULT/live account for the single-account boot path.
  const folderPath =
    context.folderPath ?? context.account?.folderPath ?? config.dataDir;

  // The acting account's repositories (per-tenant DBs).
  const repos = context.repos ?? context.account?.repos;

  if (isActivationRequired(repos)) {
    if (!ACTIVATION_EXEMPT_COMMANDS.has(command) && !senderIsOwner) {
      const activated = repos!.activation.isChatActivated(chatId);
      if (!activated) {
        const notified = repos!.activation.isExpiryNotified(chatId);
        if (!notified) {
          const sock = context.sock;
          const activation = repos!.activation.getChatActivation(chatId);
          if (activation && activation.expiresAt) {
            const now = new Date();
            const expiry = new Date(activation.expiresAt);
            if (expiry <= now) {
              try {
                await sock!.sendMessage(chatId, {
                  text: `Aktivasi sudah kadaluarsa sejak ${expiry.toLocaleDateString('id-ID')}. Gunakan /activate <kode> untuk memperpanjang.`,
                });
              } catch (err) { /* ignore */ }
              repos!.activation.markExpiryNotified(chatId);
            }
          }
        }
        return true;
      }
    }
  }

  // Per-command owner gate (replaces the inline `if (!senderIsOwner)` blocks
  // that /generate, /monitor and /revoke used in the old switch).
  if (handler.permission === "owner" && !senderIsOwner) {
    try {
      await context.sock!.sendMessage(chatId, {
        text: "Hanya owner yang bisa menggunakan perintah ini.",
      });
    } catch (e) { /* ignore */ }
    return true;
  }

  // Extract quoted message id if any. Prefer the common text-reply path
  // (extendedTextMessage), then fall back to contextInfo on any content type so
  // replies wrapped in other message kinds still resolve a quoted target (e.g.
  // for `/catch` on interactive messages).
  const { message: innerMessage } = unwrapMessage(
    msg.message as proto.IMessage | null | undefined,
  );
  const quotedMessageId =
    innerMessage?.extendedTextMessage?.contextInfo?.stanzaId ||
    extractContextInfo(innerMessage)?.stanzaId ||
    null;

  const ctx: CommandContext = {
    chatId,
    chatType,
    senderId,
    senderIsAdmin,
    senderIsOwner,
    botIsAdmin,
    args,
    text: args,
    contextMsgId: contextMsgId ?? null,
    quotedMessageId,
    senderDisplay: context.senderDisplay ?? "",
    senderRole: context.senderRole ?? null,
    isGroup: chatType === "group",
    fromMe: Boolean(fromMe),
    group: context.group ?? null,
    // Synthetic (button / run_command) messages are structurally compatible
    // with the fields handlers read; only the dispatch boundary asserts this.
    msg: msg as unknown as WAMessage,
    account: context.account,
    folderPath,
    sock: context.sock!,
    repos,
  };

  await handler.run(ctx);
  return true;
}

export { getCommand, parseSlashCommand, dispatchCommand, commandRegistry };
