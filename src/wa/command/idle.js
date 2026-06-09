import { getSock } from "../connection.js";
import wsClient from "../../wsClient.js";
import {
  getIdleTrigger,
  setIdleTrigger,
  setGlobalIdleTrigger,
} from "../../db.js";

function parseRange(value) {
  if (!value) return null;
  const rangeMatch = value.match(/^(\d+)\s*-\s*(\d+)$/);
  if (rangeMatch) {
    const min = parseInt(rangeMatch[1], 10);
    const max = parseInt(rangeMatch[2], 10);
    if (min > 0 && max > 0 && max >= min) return { min, max };
    return null;
  }
  const single = parseInt(value, 10);
  if (single > 0) return { min: single, max: single };
  return null;
}

function formatTrigger(trigger) {
  if (!trigger) return "OFF";
  if (trigger.min === trigger.max) return `${trigger.min} messages`;
  return `${trigger.min}-${trigger.max} messages`;
}

async function handleIdle({ chatId, senderIsOwner, senderIsAdmin, args }) {
  const sock = getSock();

  if (!senderIsOwner && !senderIsAdmin) {
    try {
      await sock.sendMessage(chatId, {
        text: "Only admins can use `/idle`.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (!args) {
    const current = getIdleTrigger(chatId);
    try {
      await sock.sendMessage(chatId, {
        text:
          `Idle trigger: *${formatTrigger(current)}*\n\n` +
          "Auto-trigger LLM2 after N messages of silence.\n\n" +
          "_/idle 50_ — trigger after exactly 50 messages\n" +
          "_/idle 60-80_ — random trigger between 60-80 messages\n" +
          "_/idle off_ — disable idle trigger\n" +
          "_/idle global <value>_ — set for all chats",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const parts = args.trim().toLowerCase().split(/\s+/);
  const isGlobal = parts[0] === "global";
  const value = isGlobal ? parts.slice(1).join(" ") : parts.join(" ");

  if (isGlobal && !senderIsOwner) {
    try {
      await sock.sendMessage(chatId, {
        text: "Only bot owner can use `/idle global`.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (value === "off") {
    if (isGlobal) {
      setGlobalIdleTrigger(null, null);
      wsClient.sendReliable({
        type: "invalidate_chat_settings",
        chatId: "global",
      });
    } else {
      setIdleTrigger(chatId, null, null);
      wsClient.sendReliable({ type: "invalidate_chat_settings", chatId });
    }
    try {
      await sock.sendMessage(chatId, {
        text: `Idle trigger disabled${isGlobal ? " globally" : ""}.`,
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const range = parseRange(value);
  if (!range) {
    try {
      await sock.sendMessage(chatId, {
        text: "Invalid. Use `/idle 50`, `/idle 60-80`, or `/idle off`.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (isGlobal) {
    setGlobalIdleTrigger(range.min, range.max);
    wsClient.sendReliable({
      type: "invalidate_chat_settings",
      chatId: "global",
    });
  } else {
    setIdleTrigger(chatId, range.min, range.max);
    wsClient.sendReliable({ type: "invalidate_chat_settings", chatId });
  }

  try {
    await sock.sendMessage(chatId, {
      text: `Idle trigger set${isGlobal ? " globally" : ""}: *${formatTrigger(range)}*`,
    });
  } catch (err) {
    /* ignore */
  }
}

export { handleIdle };
