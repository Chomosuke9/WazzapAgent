import logger from "../../logger.js";
import config from "../../config.js";
import * as registry from "../../server/accountRegistry.js";
import { sendNativeFlow } from "../interactive/index.js";
import {
  getAllActiveModels,
  getLlm2Model,
  setLlm2Model,
  setGlobalLlm2Model,
  getDefaultLlm2Model,
} from "../../db.js";
import type { CommandContext } from "./parseCommand.js";

async function handleModel({
  chatId,
  chatType,
  senderIsAdmin,
  senderIsOwner,
  args,
  folderPath = config.dataDir,
  sock,
}: CommandContext): Promise<void> {
  const isPrivate = chatType === "private";
  const canUse = isPrivate || senderIsOwner || senderIsAdmin;

  if (!canUse) {
    try {
      await sock.sendMessage(chatId, {
        text: "Only group admins or bot owner can change the model.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const parts = args.trim().split(/\s+/);
  const isGlobal = parts[0].toLowerCase() === "global";
  const modelIdArg = isGlobal ? parts[1] : parts[0];

  if (isGlobal && !senderIsOwner) {
    try {
      await sock.sendMessage(chatId, {
        text: "Only bot owner can change the model globally.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const models = getAllActiveModels();

  if (modelIdArg && modelIdArg !== "global") {
    const targetModel = models.find(
      (m) =>
        m.modelId.toLowerCase() === modelIdArg.toLowerCase() ||
        m.displayName.toLowerCase() === modelIdArg.toLowerCase(),
    );

    if (targetModel) {
      if (isGlobal) {
        setGlobalLlm2Model(targetModel.modelId);
        registry.sendReliableToClient(folderPath, {
          type: "set_llm2_model",
          folderPath,
          chatId: "global",
          modelId: targetModel.modelId,
        });
      } else {
        setLlm2Model(chatId, targetModel.modelId);
        registry.sendReliableToClient(folderPath, {
          type: "set_llm2_model",
          folderPath,
          chatId,
          modelId: targetModel.modelId,
        });
      }

      try {
        await sock.sendMessage(chatId, {
          text: `Model updated${isGlobal ? " globally" : ""}: *${targetModel.displayName}*`,
        });
      } catch (err) {
        /* ignore */
      }
      return;
    }
  }

  if (models.length === 0) {
    try {
      await sock.sendMessage(chatId, {
        text: "No models available. Ask the bot owner to add models using `/modelcfg`.",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const currentModelId = getLlm2Model(chatId);
  const defaultModel = getDefaultLlm2Model();
  const activeModelId = currentModelId || defaultModel?.modelId || null;
  const activeModel = models.find((m) => m.modelId === activeModelId);

  const sections = models.map((m) => ({
    title: m.displayName + (m.visionSupport ? " 👁" : ""),
    rows: [
      {
        title: m.displayName + (m.modelId === activeModelId ? " ✓" : ""),
        description: m.description || (m.visionSupport ? "Vision support" : ""),
      },
    ],
  }));

  try {
    const title = isGlobal ? "Select Model (Global)" : "Select LLM Model";
    const footer =
      "Current model: " +
      (activeModel?.displayName || "default") +
      (isGlobal
        ? "\n\nSelecting a model here will apply it to ALL chats."
        : "");

    await sendNativeFlow(
      sock,
      chatId,
      title,
      [
        {
          name: "single_select",
          buttonParamsJson: JSON.stringify({
            title: "Select Model",
            sections,
          }),
        },
      ],
      { footer },
    );
  } catch (err) {
    logger.warn({ err, chatId }, "failed sending /model interactive");
    try {
      await sock.sendMessage(chatId, {
        text: "Failed to show model list. Please try again.",
      });
    } catch (e) {
      /* ignore */
    }
  }
}

export { handleModel };
