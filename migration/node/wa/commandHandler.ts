import { unwrapMessage } from "../messageParser.js";
import {
  handleBroadcastCommand,
  handleInfoCommand,
  handleDebugCommand,
  handleJoinCommand,
  handleHelp,
  handlePrompt,
  handleReset,
  handleSticker,
  handleAddSticker,
  handleRemoveSticker,
  handlePermission,
  handleMode,
  handleTrigger,
  handleDashboard,
  handleModel,
  handleModelcfg,
  handleSettings,
  handleGroupStatus,
  handleCatch,
  handleOwnerContact,
  handleSubagent,
  handleIdle,
  handleAnnouncement,
  handleActivate,
  handleGenerate,
  handleMonitor,
  handleRevoke,
} from "./command/index.js";
import config from "../config.js";
import { isChatActivated, isExpiryNotified, markExpiryNotified, getChatActivation } from "../db.js";
import { isOwnerJid } from "../participants.js";
import type { WAMessage, proto } from "baileys";
import type { ParticipantRoleFlags, GroupContextValue } from "../caches.js";
import type { CommandContext } from "./command/index.js";
import type { AccountContext } from "../account/accountContext.js";

// The message object handed to the command listener. The real `messages.upsert`
// path passes a Baileys `WAMessage`; the button-click and `run_command` paths
// synthesize a minimal compatible shape. Both are accepted here so callers
// (e.g. `runCommand.ts`) keep type-checking without changes.
type ListenerMessage =
  | WAMessage
  | {
      key: proto.IMessageKey;
      message?: proto.IMessage | Record<string, unknown> | null;
      pushName?: string | null;
      quotedStanzaId?: string | null;
    };

// Shape of the `context` object the dispatcher (connection.ts / runCommand.ts)
// builds for each slash command. `msg` is intentionally left to the index
// signature so synthetic (non-WAMessage) callers stay compatible. Behavior is
// unchanged — this only documents the runtime object.
interface CommandListenerContext {
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sock?: any;
  [key: string]: unknown;
}

const ACTIVATION_EXEMPT_COMMANDS = new Set(["info", "activate"]);

async function handleCommandListener(
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

  // The acting account's tenant key. Control events emitted by handlers must be
  // routed to THIS account's Python client (Step 21), so resolve it from the
  // threaded AccountContext, falling back to the DEFAULT/live account's
  // folderPath (`config.dataDir`) for the single-account boot path.
  const folderPath = context.folderPath ?? context.account?.folderPath ?? config.dataDir;

  if (config.requireActivation) {
    if (!ACTIVATION_EXEMPT_COMMANDS.has(command) && !senderIsOwner) {
      const activated = isChatActivated(chatId);
      if (!activated) {
        const notified = isExpiryNotified(chatId);
        if (!notified) {
          const sock = context.sock;
          const activation = getChatActivation(chatId);
          if (activation && activation.expiresAt) {
            const now = new Date();
            const expiry = new Date(activation.expiresAt);
            if (expiry <= now) {
              try {
                await sock.sendMessage(chatId, {
                  text: `Aktivasi sudah kadaluarsa sejak ${expiry.toLocaleDateString('id-ID')}. Gunakan /activate <kode> untuk memperpanjang.`,
                });
              } catch (err) { /* ignore */ }
              markExpiryNotified(chatId);
            }
          }
        }
        return true;
      }
    }
  }

  // Extract quoted message ID if any
  const { message: innerMessage } = unwrapMessage(
    msg.message as proto.IMessage | null | undefined,
  );
  const quotedMessageId =
    innerMessage?.extendedTextMessage?.contextInfo?.stanzaId || null;

  switch (command) {
    case "help":
      await handleHelp({ sock: context.sock, chatId } as CommandContext);
      return true;

    case "activate":
      await handleActivate({ sock: context.sock, chatId, chatType, args } as CommandContext);
      return true;

    case "generate":
      if (!senderIsOwner) {
        const sock = context.sock;
        try { await sock.sendMessage(chatId, { text: "Hanya owner yang bisa menggunakan perintah ini." }); } catch (e) { /* ignore */ }
        return true;
      }
      await handleGenerate({ sock: context.sock, chatId, senderId, args } as CommandContext);
      return true;

    case "monitor":
      if (!senderIsOwner) {
        const sock = context.sock;
        try { await sock.sendMessage(chatId, { text: "Hanya owner yang bisa menggunakan perintah ini." }); } catch (e) { /* ignore */ }
        return true;
      }
      await handleMonitor({ sock: context.sock, chatId, account: context.account } as CommandContext);
      return true;

    case "revoke":
      if (!senderIsOwner) {
        const sock = context.sock;
        try { await sock.sendMessage(chatId, { text: "Hanya owner yang bisa menggunakan perintah ini." }); } catch (e) { /* ignore */ }
        return true;
      }
      await handleRevoke({ sock: context.sock, chatId, args } as CommandContext);
      return true;

    case "prompt":
      await handlePrompt({ sock: context.sock, chatId,
      chatType,
      senderIsAdmin,
      senderIsOwner,
      args,
      folderPath, } as CommandContext);
      return true;

    case "reset":
      await handleReset({ sock: context.sock, chatId,
      chatType,
      senderIsAdmin,
      senderIsOwner,
      contextMsgId,
      args,
      folderPath, } as CommandContext);
      return true;

    case "permission":
      await handlePermission({ sock: context.sock, chatId,
      chatType,
      senderIsAdmin,
      senderIsOwner,
      botIsAdmin,
      args,
      folderPath, } as CommandContext);
      return true;

    case "mode":
      await handleMode({ sock: context.sock, chatId,
      chatType,
      senderIsAdmin,
      senderIsOwner,
      senderId,
      args,
      folderPath, } as CommandContext);
      return true;

    case "trigger":
      await handleTrigger({ sock: context.sock, chatId,
      chatType,
      senderIsAdmin,
      senderIsOwner,
      senderId,
      args,
      folderPath, } as CommandContext);
      return true;

    case "dashboard":
      await handleDashboard({ sock: context.sock, chatId } as CommandContext);
      return true;

    case "broadcast":
      await handleBroadcastCommand({ sock: context.sock, chatId,
      senderId,
      text: args,
      quotedMessageId,
      contextMsgId,
      msg,
      account: context.account, } as CommandContext);
      return true;

    case "info":
      await handleInfoCommand({ sock: context.sock, chatId,
      senderId,
      senderDisplay: context.senderDisplay,
      senderRole: context.senderRole,
      isGroup: chatType === "group",
      group: context.group, } as CommandContext);
      return true;

    case "debug":
      await handleDebugCommand({ sock: context.sock, chatId, senderId, args } as CommandContext);
      return true;

    case "join":
      await handleJoinCommand({ sock: context.sock, chatId, senderId, args } as CommandContext);
      return true;

    case "sticker":
      await handleSticker({ sock: context.sock, chatId,
      chatType,
      senderIsAdmin,
      senderIsOwner,
      args,
      msg,
      account: context.account, } as CommandContext);
      return true;

    case "add-sticker":
      await handleAddSticker({ sock: context.sock, chatId,
      chatType,
      senderIsAdmin,
      senderIsOwner,
      senderId,
      args,
      msg, } as CommandContext);
      return true;

    case "remove-sticker":
      await handleRemoveSticker({ sock: context.sock, chatId,
      chatType,
      senderIsAdmin,
      senderIsOwner,
      args, } as CommandContext);
      return true;

    case "model":
      await handleModel({ sock: context.sock, chatId,
      chatType,
      senderIsAdmin,
      senderIsOwner,
      args,
      folderPath, } as CommandContext);
      return true;

    case "modelcfg":
      await handleModelcfg({ sock: context.sock, chatId, senderId, senderIsOwner, args, folderPath } as CommandContext);
      return true;

    case "setting":
      await handleSettings({ sock: context.sock, chatId,
      chatType,
      senderId,
      senderIsAdmin,
      senderIsOwner,
      args, } as CommandContext);
      return true;

    case "group-status":
      await handleGroupStatus({ sock: context.sock, chatId,
      chatType,
      senderIsAdmin,
      senderIsOwner,
      senderId,
      args,
      msg,
      fromMe, } as CommandContext);
      return true;

    case "catch":
      await handleCatch({ sock: context.sock, chatId, quotedMessageId, account: context.account } as CommandContext);
      return true;

    case "owner-contact":
      await handleOwnerContact({ sock: context.sock, chatId,
      chatType,
      senderIsAdmin,
      senderIsOwner,
      args, } as CommandContext);
      return true;

    case "subagent":
      await handleSubagent({ sock: context.sock, chatId, senderIsOwner, args, folderPath } as CommandContext);
      return true;

    case "idle":
      await handleIdle({ sock: context.sock, chatId, senderIsOwner, senderIsAdmin, args, folderPath } as CommandContext);
      return true;

    case "announcement":
      await handleAnnouncement({ sock: context.sock, chatId,
      chatType,
      senderIsAdmin,
      senderIsOwner,
      args,
      folderPath, } as CommandContext);
      return true;

    default:
      return false;
  }
}

export { handleCommandListener };
