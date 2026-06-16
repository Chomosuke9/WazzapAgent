/**
 * connection.ts — shared WhatsApp account helpers.
 *
 * After the button-registry refactor this module holds only the account-
 * parameterized helpers the factory reuses that are NOT command/button
 * descriptors:
 *
 *   - `printQrInTerminal`      — render a pairing QR in the terminal
 *   - `extractButtonSelection` — pure extraction of the tapped `selectedId`
 *     from a Baileys button / list / native-flow / template reply
 *   - `handleButtonResponse`   — thin router: extract the selection and, only
 *     when a registered handler owns it, build the once-derived
 *     {@link ButtonContext} and delegate to the auto-discovered
 *     {@link import('./command/ButtonRegistry.js').dispatchButton}
 *
 * The per-prefix button handlers themselves now live beside the commands that
 * render their menus (`commands/setting.ts` for settings / mode / model selects,
 * `commands/modelcfg.ts` for the modelcfg admin menu + its form machinery,
 * `commands/slashButton.ts` for `/`-prefixed taps) and are auto-discovered by
 * `ButtonRegistry`, mirroring how slash commands are discovered by
 * `CommandRegistry`. The shared activation + owner/admin gate is now declared
 * per handler and enforced centrally in `dispatchButton`.
 */
import { spawn } from "child_process";
import type { WASocket, WAMessage } from "baileys";
import logger from "../logger.js";
import { isOwnerJid, roleFlagsForJid } from "./domain/participants.js";
import {
  getCachedGroupMetadata,
  defaultGroupContext,
} from "./domain/groupContext.js";
import { findButtonHandler, dispatchButton } from "./command/ButtonRegistry.js";
import type { ButtonContext } from "./command/ButtonContext.js";
import type { AccountContext } from "../account/accountContext.js";

function printQrInTerminal(qr: string): void {
  try {
    const proc = spawn("qrencode", ["-t", "ANSIUTF8", "-o", "-"]);
    proc.stdin!.write(qr);
    proc.stdin!.end();
    proc.stdout!.on("data", (chunk) => process.stdout.write(chunk.toString()));
    proc.stderr!.on("data", (chunk) =>
      logger.debug({ qrErr: chunk.toString() }, "qrencode stderr"),
    );
    proc.on("error", (err) => {
      logger.warn({ err }, "qrencode not available; showing raw QR string");
      console.log("QR:", qr);
    });
  } catch (err) {
    logger.warn({ err }, "failed to render QR; showing raw");
    console.log("QR:", qr);
  }
}

/**
 * Pure extraction of the tapped button id from a Baileys message. Reads the
 * buttonsResponse / listResponse / interactive native-flow / templateButtonReply
 * shapes and returns the `selectedId`, or `null` when the message is not a
 * button / list / interactive reply.
 */
function extractButtonSelection(msg: WAMessage): string | null {
  const buttonsResponse = msg?.message?.buttonsResponseMessage;
  const listResponse = msg?.message?.listResponseMessage;
  const interactiveResponse = msg?.message?.interactiveResponseMessage;

  const nativeFlowParams = (() => {
    try {
      const paramsStr =
        interactiveResponse?.nativeFlowResponseMessage?.paramsJson;
      if (paramsStr) return JSON.parse(paramsStr);
    } catch {}
    return null;
  })();
  const tmplResponse = msg?.message?.templateButtonReplyMessage;
  const selectedId =
    buttonsResponse?.selectedButtonId ||
    listResponse?.singleSelectReply?.selectedRowId ||
    nativeFlowParams?.id ||
    tmplResponse?.selectedId;

  return selectedId ?? null;
}

/**
 * Interactive button / list / native-flow response router (Step 17: lifted to
 * module scope and account-parameterized — `sock` and `account` are passed in
 * rather than captured from a module global).
 *
 * Extracts the tapped `selectedId`, and — only when a registered handler owns
 * it — builds the once-derived {@link ButtonContext} and delegates to
 * {@link dispatchButton}, which applies the declarative activation + permission
 * gates centrally. Unmatched ids (e.g. `qz:` quiz replies) fall through
 * (`return false`) BEFORE any group-metadata work, so the chatbot path can
 * forward them to LLM2.
 *
 * @returns true if the response was fully handled (caller should `continue`).
 */
async function handleButtonResponse(
  sock: WASocket,
  account: AccountContext,
  msg: WAMessage,
  chatId: string,
  senderId: string,
): Promise<boolean> {
  const selectedId = extractButtonSelection(msg);
  if (!selectedId) return false;

  // Fast path: nothing owns this id (e.g. `qz:` quiz answers, which LLM2 must
  // evaluate) → fall through WITHOUT doing any group-metadata work.
  if (!findButtonHandler(selectedId)) return false;
  logger.info({ selectedId, chatId }, "button selected");

  const isGroup = chatId.endsWith("@g.us");
  const group = isGroup
    ? getCachedGroupMetadata(account, chatId) || defaultGroupContext(chatId)
    : null;
  const senderRole = isGroup
    ? roleFlagsForJid(group?.participantRoles, senderId)
    : { isAdmin: false, isSuperAdmin: false };
  const senderIsAdmin = senderRole.isAdmin || senderRole.isSuperAdmin;
  const senderIsOwner = isOwnerJid(senderId);

  const bc: ButtonContext = {
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
  };

  return await dispatchButton(bc, selectedId);
}

export { printQrInTerminal, handleButtonResponse, extractButtonSelection };
