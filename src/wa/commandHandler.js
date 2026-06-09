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
import { getSock } from "./connection.js";
import { isOwnerJid } from "../participants.js";

const ACTIVATION_EXEMPT_COMMANDS = new Set(["info", "activate"]);

async function handleCommandListener(msg, context) {
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

  if (config.requireActivation) {
    if (!ACTIVATION_EXEMPT_COMMANDS.has(command) && !senderIsOwner) {
      const activated = isChatActivated(chatId);
      if (!activated) {
        const notified = isExpiryNotified(chatId);
        if (!notified) {
          const sock = getSock();
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
  const { message: innerMessage } = unwrapMessage(msg.message);
  const quotedMessageId =
    innerMessage?.extendedTextMessage?.contextInfo?.stanzaId || null;

  switch (command) {
    case "help":
      await handleHelp({ chatId });
      return true;

    case "activate":
      await handleActivate({ chatId, chatType, args });
      return true;

    case "generate":
      if (!senderIsOwner) {
        const sock = getSock();
        try { await sock.sendMessage(chatId, { text: "Hanya owner yang bisa menggunakan perintah ini." }); } catch (e) { /* ignore */ }
        return true;
      }
      await handleGenerate({ chatId, senderId, args });
      return true;

    case "monitor":
      if (!senderIsOwner) {
        const sock = getSock();
        try { await sock.sendMessage(chatId, { text: "Hanya owner yang bisa menggunakan perintah ini." }); } catch (e) { /* ignore */ }
        return true;
      }
      await handleMonitor({ chatId });
      return true;

    case "revoke":
      if (!senderIsOwner) {
        const sock = getSock();
        try { await sock.sendMessage(chatId, { text: "Hanya owner yang bisa menggunakan perintah ini." }); } catch (e) { /* ignore */ }
        return true;
      }
      await handleRevoke({ chatId, args });
      return true;

    case "prompt":
      await handlePrompt({
        chatId,
        chatType,
        senderIsAdmin,
        senderIsOwner,
        args,
      });
      return true;

    case "reset":
      await handleReset({
        chatId,
        chatType,
        senderIsAdmin,
        senderIsOwner,
        contextMsgId,
        args,
      });
      return true;

    case "permission":
      await handlePermission({
        chatId,
        chatType,
        senderIsAdmin,
        senderIsOwner,
        botIsAdmin,
        args,
      });
      return true;

    case "mode":
      await handleMode({
        chatId,
        chatType,
        senderIsAdmin,
        senderIsOwner,
        senderId,
        args,
      });
      return true;

    case "trigger":
      await handleTrigger({
        chatId,
        chatType,
        senderIsAdmin,
        senderIsOwner,
        senderId,
        args,
      });
      return true;

    case "dashboard":
      await handleDashboard({ chatId });
      return true;

    case "broadcast":
      await handleBroadcastCommand({
        chatId,
        senderId,
        text: args,
        quotedMessageId,
        contextMsgId,
        msg,
      });
      return true;

    case "info":
      await handleInfoCommand({
        chatId,
        senderId,
        senderDisplay: context.senderDisplay,
        senderRole: context.senderRole,
        isGroup: chatType === "group",
        group: context.group,
      });
      return true;

    case "debug":
      await handleDebugCommand({ chatId, senderId, args });
      return true;

    case "join":
      await handleJoinCommand({ chatId, senderId, args });
      return true;

    case "sticker":
      await handleSticker({
        chatId,
        chatType,
        senderIsAdmin,
        senderIsOwner,
        args,
        msg,
      });
      return true;

    case "add-sticker":
      await handleAddSticker({
        chatId,
        chatType,
        senderIsAdmin,
        senderIsOwner,
        senderId,
        args,
        msg,
      });
      return true;

    case "remove-sticker":
      await handleRemoveSticker({
        chatId,
        chatType,
        senderIsAdmin,
        senderIsOwner,
        args,
      });
      return true;

    case "model":
      await handleModel({
        chatId,
        chatType,
        senderIsAdmin,
        senderIsOwner,
        args,
      });
      return true;

    case "modelcfg":
      await handleModelcfg({ chatId, senderId, senderIsOwner, args });
      return true;

    case "setting":
      await handleSettings({
        chatId,
        chatType,
        senderId,
        senderIsAdmin,
        senderIsOwner,
        args,
      });
      return true;

    case "group-status":
      await handleGroupStatus({
        chatId,
        chatType,
        senderIsAdmin,
        senderIsOwner,
        senderId,
        args,
        msg,
        fromMe,
      });
      return true;

    case "catch":
      await handleCatch({ chatId, quotedMessageId });
      return true;

    case "owner-contact":
      await handleOwnerContact({
        chatId,
        chatType,
        senderIsAdmin,
        senderIsOwner,
        args,
      });
      return true;

    case "subagent":
      await handleSubagent({ chatId, senderIsOwner, args });
      return true;

    case "idle":
      await handleIdle({ chatId, senderIsOwner, senderIsAdmin, args });
      return true;

    case "announcement":
      await handleAnnouncement({
        chatId,
        chatType,
        senderIsAdmin,
        senderIsOwner,
        args,
      });
      return true;

    default:
      return false;
  }
}

export { handleCommandListener };
