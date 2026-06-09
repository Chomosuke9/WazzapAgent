import { getSock } from "../connection.js";
import wsClient from "../../wsClient.js";
import {
  getTriggers,
  setTriggers,
  setGlobalTriggers,
  VALID_TRIGGERS,
} from "../../db.js";

const TRIGGER_DESCRIPTIONS = {
  tag: "bot @mentioned",
  reply: "replied to bot message",
  join: "new member joins group",
  name: "bot name mentioned in text",
};

async function handleTrigger({
  chatId,
  chatType,
  senderIsAdmin,
  senderIsOwner,
  senderId,
  args,
}) {
  const sock = getSock();

  if (chatType === "private") {
    try {
      await sock.sendMessage(chatId, {
        text: "`/trigger` can only be used in group chats.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (!senderIsOwner && !senderIsAdmin) {
    try {
      await sock.sendMessage(chatId, {
        text: "Only group admins can change triggers.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (!args) {
    const current = getTriggers(chatId);
    if (current.size > 0) {
      const lines = [...current]
        .sort()
        .map((t) => `  - ${t}: ${TRIGGER_DESCRIPTIONS[t] || t}`);
      try {
        await sock.sendMessage(chatId, {
          text: "Current triggers:\n" + lines.join("\n"),
        });
      } catch (err) {
        /* ignore */
      }
    } else {
      try {
        await sock.sendMessage(chatId, {
          text: "No triggers enabled. Bot won't respond in prefix mode.\nUse `/trigger` all to enable all triggers.",
        });
      } catch (err) {
        /* ignore */
      }
    }
    return;
  }

  const parts = args.trim().toLowerCase().split(/\s+/);
  const isGlobal = parts[0] === "global";
  const cleaned = isGlobal
    ? parts.slice(1).join(" ")
    : args.trim().toLowerCase();

  if (isGlobal && !senderIsOwner) {
    try {
      await sock.sendMessage(chatId, {
        text: "Only bot owner can set global triggers.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (cleaned === "all") {
    if (isGlobal) {
      setGlobalTriggers(VALID_TRIGGERS);
      wsClient.sendReliable({
        type: "invalidate_chat_settings",
        chatId: "global",
      });
    } else {
      setTriggers(chatId, VALID_TRIGGERS);
      wsClient.sendReliable({ type: "invalidate_chat_settings", chatId });
    }
    try {
      await sock.sendMessage(chatId, {
        text:
          `All triggers enabled${isGlobal ? " globally" : ""}: ` +
          [...VALID_TRIGGERS].sort().join(", "),
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (cleaned === "none") {
    if (isGlobal) {
      setGlobalTriggers(new Set());
      wsClient.sendReliable({
        type: "invalidate_chat_settings",
        chatId: "global",
      });
    } else {
      setTriggers(chatId, new Set());
      wsClient.sendReliable({ type: "invalidate_chat_settings", chatId });
    }
    try {
      await sock.sendMessage(chatId, {
        text: `All triggers disabled${isGlobal ? " globally" : ""}. Bot won't respond in prefix mode.`,
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const requested = new Set(
    cleaned
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  );
  const invalid = [...requested].filter((t) => !VALID_TRIGGERS.has(t));
  if (invalid.length > 0) {
    try {
      await sock.sendMessage(chatId, {
        text: `Invalid trigger(s): ${invalid.sort().join(", ")}\nValid: ${[...VALID_TRIGGERS].sort().join(", ")}`,
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const current = getTriggers(chatId);
  const toggledOn = new Set([...requested].filter((t) => !current.has(t)));
  const toggledOff = new Set([...requested].filter((t) => current.has(t)));
  const newTriggers = new Set([...current, ...toggledOn]);
  for (const t of toggledOff) newTriggers.delete(t);

  if (isGlobal) {
    setGlobalTriggers(newTriggers);
    wsClient.sendReliable({
      type: "invalidate_chat_settings",
      chatId: "global",
    });
  } else {
    setTriggers(chatId, newTriggers);
    wsClient.sendReliable({ type: "invalidate_chat_settings", chatId });
  }

  const statusLines = [...requested]
    .sort()
    .map((t) => `  - ${t}: ${toggledOn.has(t) ? "enabled" : "disabled"}`);
  const activeStr =
    newTriggers.size > 0 ? [...newTriggers].sort().join(", ") : "none";
  try {
    await sock.sendMessage(chatId, {
      text: statusLines.join("\n") + `\nActive triggers: ${activeStr}`,
    });
  } catch (err) {
    /* ignore */
  }
}

export { handleTrigger };
