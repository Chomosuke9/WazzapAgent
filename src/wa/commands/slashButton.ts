import logger from "../../logger.js";
import { parseSlashCommand, dispatchCommand } from "../command/CommandRegistry.js";
import type { ButtonHandler } from "../command/ButtonContext.js";

// ---------------------------------------------------------------------------
// `/`-prefixed button → slash command dispatch
// ---------------------------------------------------------------------------

/**
 * A tapped `/`-prefixed quick-reply (e.g. a `/help` button) is dispatched as a
 * normal slash command through `CommandRegistry`. The handler reconstructs the
 * synthetic message + `CommandListenerContext` exactly as the old inline
 * `handleSlashButton` did.
 *
 * `requireActivation: false` + `permission: "public"` are deliberate: the slash
 * dispatcher (`dispatchCommand`) performs ITS OWN activation gate (with the
 * `/info` / `/activate` exemptions) and ITS OWN per-command permission gate, so
 * this button handler must NOT pre-empt either — it just forwards the tap.
 */
export const slashButton: ButtonHandler = {
  prefixes: ["/"],
  permission: "public",
  requireActivation: false,
  run: async (bc, payload) => {
    const {
      sock,
      account,
      msg,
      chatId,
      senderId,
      isGroup,
      group,
      senderRole,
      senderIsAdmin,
      senderIsOwner,
    } = bc;
    // The matched prefix ("/") was stripped into `payload`; the dispatcher
    // expects the full slash text (e.g. "/help"), so re-prepend it.
    const selectedId = "/" + payload;
    logger.info(
      { selectedId, chatId, senderId },
      "button click -> slash command",
    );
    const slashCommand = parseSlashCommand(selectedId);
    if (!slashCommand) return;
    const fakeMsg = {
      key: { ...msg.key, id: `btn_${Date.now()}` },
      message: { conversation: selectedId },
      pushName: msg.pushName,
    };
    const context = {
      slashCommand,
      chatId,
      chatType: isGroup ? "group" : "private",
      senderId,
      senderIsAdmin,
      senderIsOwner,
      senderRole,
      senderDisplay: msg.pushName || "",
      botIsAdmin: group?.botIsAdmin || false,
      botIsSuperAdmin: group?.botIsSuperAdmin || false,
      contextMsgId: null,
      text: selectedId,
      group,
      msg: fakeMsg,
      account,
      sock,
      repos: account.repos,
    };
    await dispatchCommand(fakeMsg, context);
  },
};
