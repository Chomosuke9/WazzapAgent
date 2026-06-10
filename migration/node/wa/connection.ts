/**
 * connection.ts — shared WhatsApp account helpers (Step 17).
 *
 * Step 17 extracted Baileys socket creation and ALL event-listener wiring into
 * `account/baileysFactory.ts` so one Node process can drive N accounts, each
 * bound to its own {@link AccountContext}. What remains here are the shared,
 * account-parameterized helpers the factory (and the rest of the gateway) reuse:
 *
 *   - `printQrInTerminal`        — render a pairing QR in the terminal
 *   - `handleButtonResponse`     — interactive button / list / form responses
 *   - `parseModelReply`          — parse a `/modelcfg` form reply
 *   - model form helpers         — show edit/add/default model menus & forms
 *
 * It also keeps THIN shims used by the still-live single-account boot:
 *
 *   - `startWhatsApp()`   — creates/resumes the DEFAULT account via the factory
 *
 * Lazy imports are used for `baileysFactory.js` to avoid a circular dependency
 * (the factory statically imports the shared helpers from this module).
 */
import { spawn } from "child_process";
import type { WASocket, WAMessage } from "baileys";
import logger from "../logger.js";
import config from "../config.js";
import { parseSlashCommand } from "./command/index.js";
import { isOwnerJid } from "../participants.js";
import { roleFlagsForJid } from "../participants.js";
import {
  getCachedGroupMetadata,
  defaultGroupContext,
} from "../groupContext.js";
import {
  getLlm2Model,
  setLlm2Model,
  getAllActiveModels,
  getAllModels,
  getDefaultLlm2Model,
  deleteModel,
  updateModel,
} from "../db.js";
import { isChatActivated } from "../db.js";
import { sendNativeFlow } from "./interactive/index.js";
import type { AccountContext, PendingForm } from "../account/accountContext.js";
import * as registry from "../server/accountRegistry.js";

// In-flight model-config form per chat lives on the AccountContext
// (`ctx.pendingForms`) so each account keeps independent `/modelcfg` form
// state. `PendingForm` is imported from `account/accountContext.js`.

// Result of parsing a model-config form reply. Fields beyond `action` are
// populated depending on the form type / validity (mirrors the original
// runtime object).
interface ModelReplyResult {
  action: "edit_model" | "add_model";
  modelId?: string;
  success?: boolean;
  updates?: {
    displayName?: string;
    description?: string;
    isActive?: boolean;
    sortOrder?: number;
    visionSupport?: boolean;
  };
  error?: string;
  displayName?: string;
  description?: string;
  visionSupport?: boolean;
}

function clearPendingForm(ctx: AccountContext, chatId: string): void {
  ctx.pendingForms.delete(chatId);
}

function getPendingForm(ctx: AccountContext, chatId: string): PendingForm | undefined {
  return ctx.pendingForms.get(chatId);
}

function parseModelReply(ctx: AccountContext, chatId: string, text: string): ModelReplyResult | null {
  const form = ctx.pendingForms.get(chatId);
  if (!form) return null;

  const fields = text
    .split("|")
    .map((f) => f.trim())
    .filter(Boolean);

  if (form.type === "edit_model") {
    const modelId = form.modelId;
    clearPendingForm(ctx, chatId);

    const updates: ModelReplyResult["updates"] = {};

    for (const field of fields) {
      const eqIdx = field.indexOf("=");
      if (eqIdx < 1) continue;
      const k = field.slice(0, eqIdx).trim().toLowerCase();
      const v = field.slice(eqIdx + 1).trim();

      if (k === "name") updates.displayName = v;
      else if (k === "desc") updates.description = v;
      else if (k === "active")
        updates.isActive = v === "1" || v === "true" || v === "yes";
      else if (k === "order") {
        const n = parseInt(v, 10);
        if (!isNaN(n)) updates.sortOrder = n;
      } else if (k === "vision")
        updates.visionSupport = v === "true" || v === "1" || v === "yes";
    }

    const success = updateModel(modelId, updates);
    return { action: "edit_model", modelId, success, updates };
  }

  if (form.type === "add_model") {
    clearPendingForm(ctx, chatId);
    if (fields.length < 2) {
      return {
        action: "add_model",
        error: "Format: model_id|display_name|[description]|[vision=true]",
      };
    }
    const modelId = fields[0];
    const displayName = fields[1];

    // Parse remaining fields: key=value pairs and bare true/false as metadata,
    // everything else as description text
    let visionSupport = false;
    const descParts: string[] = [];
    for (let i = 2; i < fields.length; i++) {
      const field = fields[i];
      const lowerField = field.toLowerCase();
      // Check for key=value pairs (e.g. vision=true)
      const eqIdx = field.indexOf("=");
      if (eqIdx > 0) {
        const k = field.slice(0, eqIdx).trim().toLowerCase();
        const v = field
          .slice(eqIdx + 1)
          .trim()
          .toLowerCase();
        if (k === "vision") {
          visionSupport = v === "true" || v === "1" || v === "yes";
          continue;
        }
      }
      // Check for bare true/false as standalone vision flag
      if (lowerField === "true" || lowerField === "false") {
        visionSupport = lowerField === "true";
        continue;
      }
      // Otherwise it's description text
      descParts.push(field);
    }
    const description = descParts.join(" ");
    return {
      action: "add_model",
      modelId,
      displayName,
      description,
      visionSupport,
    };
  }

  return null;
}

async function showModelSelectionForEdit(sock: WASocket, chatId: string): Promise<void> {
  const models = getAllModels();
  if (models.length === 0) {
    await sock.sendMessage(chatId, { text: "No models to edit." });
    return;
  }
  const sections = [
    {
      title: "Select Model to Edit",
      rows: models.map((m) => ({
        id: `/modelcfg edit ${m.modelId}`,
        title:
          m.displayName +
          (m.isActive ? "" : " (inactive)") +
          (m.visionSupport ? " 👁" : ""),
        description: m.description || `ID: ${m.modelId}`,
      })),
    },
  ];
  await sendNativeFlow(
    sock,
    chatId,
    "Edit Model",
    [
      {
        name: "single_select",
        buttonParamsJson: JSON.stringify({ title: "Select Model", sections }),
      },
    ],
    { footer: "Select a model to edit" },
  );
}

async function showModelEditForm(
  sock: WASocket,
  ctx: AccountContext,
  chatId: string,
  senderId: string,
  modelId: string,
): Promise<void> {
  const models = getAllModels();
  const model = models.find((m) => m.modelId === modelId);
  if (!model) {
    await sock.sendMessage(chatId, { text: `Model "${modelId}" not found.` });
    return;
  }

  ctx.pendingForms.set(chatId, { type: "edit_model", modelId, senderId });

  const helpText = `Edit Model: ${model.displayName}

Current values:
- name=${model.displayName}
- desc=${model.description || ""}
- active=${model.isActive ? "1" : "0"}
- order=${model.sortOrder}
- vision=${model.visionSupport ? "true" : "false"}

Send your changes using | as separator:
name=New Name|desc=New description|vision=true

Or send "cancel" to cancel.`;

  await sock.sendMessage(chatId, { text: helpText });
}

async function showModelAddForm(sock: WASocket, ctx: AccountContext, chatId: string, senderId: string): Promise<void> {
  ctx.pendingForms.set(chatId, { type: "add_model", senderId });

  const helpText = `Add New Model

Send using | as separator:
model_id|display_name|description|vision=true

Examples:
gpt-4o|GPT-4 Omni|Fast and capable model|vision=true
kimi-k2.6|Kimi|vision=true
my-model|My Custom Model

Or send "cancel" to cancel.`;

  await sock.sendMessage(chatId, { text: helpText });
}

async function showModelSelectionForDefault(sock: WASocket, chatId: string): Promise<void> {
  const models = getAllModels().filter((m) => m.isActive);
  if (models.length === 0) {
    await sock.sendMessage(chatId, {
      text: "No active models to set as default.",
    });
    return;
  }
  const sections = [
    {
      title: "Select Default Model",
      rows: models.map((m) => ({
        id: `/modelcfg default ${m.modelId}`,
        title: m.displayName + (m.visionSupport ? " 👁" : ""),
        description: m.description || `ID: ${m.modelId}`,
      })),
    },
  ];
  await sendNativeFlow(
    sock,
    chatId,
    "Set Default Model",
    [
      {
        name: "single_select",
        buttonParamsJson: JSON.stringify({ title: "Select Default", sections }),
      },
    ],
    { footer: "Model with smallest order will be used as default" },
  );
}

async function setDefaultModel(sock: WASocket, folderPath: string, chatId: string, modelId: string): Promise<void> {
  const models = getAllModels();
  const model = models.find((m) => m.modelId === modelId);
  if (!model) {
    await sock.sendMessage(chatId, { text: `Model "${modelId}" not found.` });
    return;
  }
  const allModels = getAllModels();
  const minOrder = Math.min(...allModels.map((m) => m.sortOrder));
  updateModel(modelId, { sortOrder: minOrder - 1 });
  registry.sendReliableToClient(folderPath, { type: "invalidate_default_model", folderPath });
  await sock.sendMessage(chatId, {
    text: `Model "${model.displayName}" set as default.`,
  });
}

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
 * Interactive button / list / native-flow response handler (Step 17: lifted to
 * module scope and account-parameterized — `sock` and `account` are passed in
 * rather than captured from a module global).
 *
 * Handles model-selection menus, settings menus, and `/modelcfg` admin menus.
 * Quiz (`qz:`) replies are intentionally NOT handled here — they fall through
 * to the chatbot path so LLM2 can evaluate the answer.
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

  if (!selectedId) return false;
  logger.info({ selectedId, chatId }, "button selected");

  // Quiz button replies (qz: prefix) are forwarded to Python as plain
  // incoming messages so LLM2 can evaluate the answer. Do NOT handle
  // them here — let them fall through to handleIncomingMessage().
  if (selectedId.startsWith("qz:")) return false;

  const isGroup = chatId.endsWith("@g.us");
  const group = isGroup
    ? getCachedGroupMetadata(account, chatId) || defaultGroupContext(chatId)
    : null;
  const senderRole = isGroup
    ? roleFlagsForJid(group?.participantRoles, senderId)
    : { isAdmin: false, isSuperAdmin: false };
  const senderIsAdmin = senderRole.isAdmin || senderRole.isSuperAdmin;
  const senderIsOwner = isOwnerJid(senderId);

  try {
    if (selectedId.startsWith("/")) {
      logger.info(
        { selectedId, chatId, senderId },
        "button click -> slash command",
      );
      const { handleCommandListener } = await import("./commandHandler.js");
      const slashCommand = parseSlashCommand(selectedId);
      if (slashCommand) {
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
        };
        await handleCommandListener(fakeMsg, context);
      }
      return true;
    }

    if (selectedId.startsWith("model_select:")) {
      if (config.requireActivation && !senderIsOwner && !isChatActivated(chatId)) {
        return true;
      }
      const modelId = selectedId.replace("model_select:", "");
      const canUse = senderIsOwner || (isGroup && senderIsAdmin);
      if (!canUse) {
        await sock.sendMessage(chatId, {
          text: "Only group admins or bot owner can change the model.",
        });
        return true;
      }
      setLlm2Model(chatId, modelId);
      registry.sendReliableToClient(account.folderPath, {
        type: "set_llm2_model",
        folderPath: account.folderPath,
        chatId,
        modelId,
      });
      registry.sendReliableToClient(account.folderPath, {
        type: "invalidate_llm2_model",
        folderPath: account.folderPath,
        chatId,
      });
      const models = getAllActiveModels();
      const model = models.find((m) => m.modelId === modelId);
      const displayName = model?.displayName || modelId;
      const visionNote = model?.visionSupport ? " (Vision)" : "";
      await sock.sendMessage(chatId, {
        text: `Model diubah ke: ${displayName}${visionNote}`,
      });
      return true;
    }

    if (selectedId.startsWith("settings:")) {
      if (config.requireActivation && !senderIsOwner && !isChatActivated(chatId)) {
        return true;
      }
      const action = selectedId.replace("settings:", "");
      const canUse = senderIsOwner || (isGroup && senderIsAdmin);
      if (!canUse) {
        await sock.sendMessage(chatId, {
          text: "Only group admins or bot owner can access settings.",
        });
        return true;
      }
      if (action === "model") {
        const models = getAllActiveModels();
        if (models.length === 0) {
          await sock.sendMessage(chatId, { text: "No models available." });
          return true;
        }
        const currentModelId = getLlm2Model(chatId);
        const defaultModel = getDefaultLlm2Model();
        const activeModelId = currentModelId || defaultModel?.modelId || null;
        const sections = models.map((m) => ({
          title: m.displayName + (m.visionSupport ? " 👁" : ""),
          rows: [
            {
              title:
                m.displayName + (m.modelId === activeModelId ? " ✓" : ""),
              description:
                m.description || (m.visionSupport ? "Vision support" : ""),
              id: `model_select:${m.modelId}`,
            },
          ],
        }));
        await sendNativeFlow(
          sock,
          chatId,
          "Pilih Model LLM",
          [
            {
              name: "single_select",
              buttonParamsJson: JSON.stringify({
                title: "Pilih Model",
                sections,
              }),
            },
          ],
          { footer: "Model saat ini: " + (activeModelId || "default") },
        );
        return true;
      }
      if (action === "prompt") {
        await sock.sendMessage(chatId, {
          text: "Gunakan `/prompt` <teks> untuk mengubah prompt.",
        });
        return true;
      }
      if (action === "permission") {
        await sock.sendMessage(chatId, {
          text: "Gunakan `/permission` <0-3> untuk mengubah level.",
        });
        return true;
      }
      return true;
    }

    if (
      selectedId.startsWith("modelcfg:") ||
      selectedId.startsWith("modelcfg_")
    ) {
      if (!isOwnerJid(senderId)) {
        await sock.sendMessage(chatId, {
          text: "Only bot owner can manage models.",
        });
        return true;
      }

      const subcommand = selectedId
        .replace("modelcfg:", "")
        .replace("modelcfg_", "");
      const colonIdx = subcommand.indexOf(":");
      const action =
        colonIdx >= 0 ? subcommand.slice(0, colonIdx) : subcommand;
      const modelId = colonIdx >= 0 ? subcommand.slice(colonIdx + 1) : "";

      if (action === "list") {
        const models = getAllModels();
        if (models.length === 0) {
          await sock.sendMessage(chatId, { text: "No models configured." });
          return true;
        }
        const lines = ["*Daftar Model:*"];
        const defaultModel = getDefaultLlm2Model();
        for (const m of models) {
          const isDefault = defaultModel?.modelId === m.modelId;
          const vision = m.visionSupport ? " 👁" : "";
          lines.push(
            `${isDefault ? "✓" : "○"} ${m.displayName} (${m.modelId})${isDefault ? " [DEFAULT]" : ""}${vision}`,
          );
          if (m.description) lines.push(`   ${m.description}`);
        }
        await sock.sendMessage(chatId, { text: lines.join("\n") });
        return true;
      }

      if (action === "add") {
        await showModelAddForm(sock, account, chatId, senderId);
        return true;
      }

      if (action === "edit") {
        await showModelSelectionForEdit(sock, chatId);
        return true;
      }

      if (action === "default") {
        if (modelId) {
          await setDefaultModel(sock, account.folderPath, chatId, modelId);
        } else {
          await showModelSelectionForDefault(sock, chatId);
        }
        return true;
      }

      if (action === "remove") {
        if (modelId) {
          const result = deleteModel(modelId);
          if (result.success) {
            registry.sendReliableToClient(account.folderPath, {
              type: "invalidate_default_model",
              folderPath: account.folderPath,
            });
            for (const affectedChatId of result.affectedChatIds) {
              registry.sendReliableToClient(account.folderPath, {
                type: "set_llm2_model",
                folderPath: account.folderPath,
                chatId: affectedChatId,
                modelId: null,
              });
              registry.sendReliableToClient(account.folderPath, {
                type: "clear_history",
                folderPath: account.folderPath,
                chatId: affectedChatId,
              });
              registry.sendReliableToClient(account.folderPath, {
                type: "invalidate_llm2_model",
                folderPath: account.folderPath,
                chatId: affectedChatId,
              });
            }
          }
          const models = getAllModels();
          const model = models.find((m) => m.modelId === modelId);
          const displayName = model?.displayName || modelId;
          await sock.sendMessage(chatId, {
            text: result.success
              ? `Model "${displayName}" removed.`
              : `Model "${modelId}" not found.`,
          });
        } else {
          await sock.sendMessage(chatId, {
            text: "Usage: `/modelcfg` remove <model_id>",
          });
        }
        return true;
      }

      return true;
    }
  } catch (err) {
    logger.error({ err }, "button response handler error");
  }
  return false;
}

/**
 * Initialize and start the WhatsApp socket for the single-account live boot.
 *
 * Step 17: socket creation + all event-listener wiring now live in
 * `account/baileysFactory.ts`. This is a THIN shim that creates/resumes the
 * DEFAULT account (keyed by `config.dataDir`) through the factory and returns
 * its live socket, so `index.ts`'s existing boot path keeps working unchanged.
 *
 * Step 18: the legacy `whatsapp_status` forwarding that used to live in
 * `onStatusChange` here now happens inside the factory's `connection.update`
 * via `eventForwarder.forwardStatus`, which routes through the account registry
 * (best-effort vs reliable preserved). The hook is left in place purely for
 * logging/extension so `whatsapp_status` is emitted EXACTLY ONCE (by the
 * forwarder, not here).
 *
 * @returns The connected (default account) socket instance.
 */
async function startWhatsApp(): Promise<WASocket> {
  const { createOrResumeAccount } = await import(
    "../account/baileysFactory.js"
  );
  const entry = await createOrResumeAccount({
    folderPath: config.dataDir,
    printQr: true,
    onStatusChange: (status, reason) => {
      // Step 18: whatsapp_status is now sent by eventForwarder.forwardStatus
      // inside the factory (exactly once). Keep this as a no-op side-hook to
      // avoid a double-send of the status frame.
      logger.debug({ status, reason, folderPath: config.dataDir }, "whatsapp status change");
    },
  });
  return entry.sock as WASocket;
}

export {
  startWhatsApp,
  printQrInTerminal,
  handleButtonResponse,
  parseModelReply,
  getPendingForm,
  clearPendingForm,
};
