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
import { parseRawSlash } from "../commands/parseCommand.js";
import { isActivationRequired } from "../botConfig.js";
import type { proto, WAMessage } from "baileys";
import type { ParticipantRoleFlags, GroupContextValue } from "../domain/caches.js";
import type { AccountContext } from "../../account/accountContext.js";
import type { AccountRepositories } from "../../db/repositories/index.js";
import type { CommandContext, CommandHandler } from "./CommandContext.js";
import type { WaSocketLike } from "../../protocol/ports.js";
import {
  resolveAtom,
  isPermitted as isPermittedBy,
  validatePermission,
  describePermission,
} from "./permission.js";

import { readdirSync } from "fs";
import { join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

/**
 * Token → handler map. Keyed by each command's canonical name and every alias.
 *
 * Built once by {@link initCommandRegistry} via auto-discovery of the command
 * descriptor files in `../commands/`. Starts empty and is replaced wholesale by
 * the init function before the WS server starts; duplicate tokens are a
 * programming error and throw during init.
 */
let commandRegistry: Map<string, CommandHandler> = new Map();

/** Structural guard: an exported value that satisfies the CommandHandler shape. */
function isCommandHandler(val: unknown): val is CommandHandler {
  const v = val as Record<string, unknown>;
  return (
    typeof val === "object" &&
    val !== null &&
    Array.isArray(v.commands) &&
    v.commands.length > 0 &&
    v.commands.every((t) => typeof t === "string") &&
    typeof v.run === "function"
  );
}

// ---------------------------------------------------------------------------
// Permission DSL (atom resolution)
// ---------------------------------------------------------------------------
//
// A command's `permission` is a boolean expression over atoms, combined with
// `and` / `or` and optional parentheses, e.g.
// `"private or (isGroup and isAdmin) or isOwner"`. The parser/evaluator,
// init-time validation and the human-readable labels are context-agnostic and
// live in `./permission.ts`; only atom RESOLUTION (mapping an atom name to a
// truth value for THIS invocation's `CommandListenerContext`) lives here.

/** Resolve a canonical atom against the invocation context. */
function resolvePermissionAtom(
  name: string,
  context: CommandListenerContext,
): boolean {
  return resolveAtom(name, {
    isOwner: Boolean(context.senderIsOwner),
    isAdmin: Boolean(context.senderIsAdmin),
    isGroup: context.chatType === "group",
    isPrivate: context.chatType !== "group",
    fromMe: Boolean(context.fromMe),
  });
}

/** Whether the invocation satisfies the command's permission expression. */
function isPermitted(
  permission: string,
  context: CommandListenerContext,
): boolean {
  return isPermittedBy(permission, (name) =>
    resolvePermissionAtom(name, context),
  );
}

/**
 * Auto-discover every `CommandHandler` descriptor under `../commands/` and build
 * the token → handler registry. Each command file exports exactly one handler
 * descriptor; adding a command means adding one file in that folder — no import
 * or array entry to keep in sync here.
 *
 * Must be awaited once during boot (before the WS server starts) so the
 * registry is populated before any dispatch can occur.
 */
async function initCommandRegistry(): Promise<void> {
  const commandDir = fileURLToPath(new URL("../commands/", import.meta.url));
  const files = readdirSync(commandDir).filter(
    (f) => f.endsWith(".ts") && f !== "index.ts" && f !== "parseCommand.ts",
  );
  const handlers: CommandHandler[] = [];
  for (const file of files) {
    const fileUrl = pathToFileURL(join(commandDir, file)).href;
    const mod = await import(fileUrl);
    for (const val of Object.values(mod)) {
      if (isCommandHandler(val)) handlers.push(val);
    }
  }
  const map = new Map<string, CommandHandler>();
  for (const handler of handlers) {
    const canonical = handler.commands[0];
    validatePermission(handler.permission, canonical);
    for (const token of handler.commands) {
      if (map.has(token)) {
        throw new Error(`Duplicate command token registered: ${token}`);
      }
      map.set(token, handler);
    }
  }
  commandRegistry = map;
}

/** Resolve a raw (lowercased) command token to its handler, if known. */
function getCommand(token: string): CommandHandler | undefined {
  return commandRegistry.get(token);
}

/**
 * Every registered command handler, de-duplicated across name + aliases (the
 * registry maps every token to the same handler instance). Order is not
 * guaranteed; callers that need a stable order should sort. Used by `/help` to
 * auto-generate its listing.
 */
function listCommands(): CommandHandler[] {
  return [...new Set(commandRegistry.values())];
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
  return { command: handler.commands[0], args: raw.args };
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
                  text: `Activation expired on ${expiry.toLocaleDateString('id-ID')}. Use /activate <code> to renew.`,
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

  // Declarative permission gate. The expression is evaluated against this
  // invocation (owner/admin/group/private/from_me). A recognised-but-denied
  // command is suppressed (returns true) after a generic rejection reply.
  if (!isPermitted(handler.permission, context)) {
    try {
      await context.sock!.sendMessage(chatId, {
        text: `This command is only for ${describePermission(handler.permission)}. ❌`,
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

  await handler.run(ctx.sock, ctx.msg, ctx);
  return true;
}

export { getCommand, listCommands, parseSlashCommand, dispatchCommand, commandRegistry, initCommandRegistry };
