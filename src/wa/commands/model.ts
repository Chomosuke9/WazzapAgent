// /model — list or set the LLM2 model for this chat.
//
// The model picker had been folded into the /setting `single_select` menu
// (the `model_select:` button), which only renders on Android. This restores a
// typed command so the TEXT settings menu (iOS/web/desktop) can change it too.
// Setting a model mirrors the `model_select:` button: it persists the per-chat
// model and broadcasts `set_llm2_model` + `invalidate_llm2_model` so the Python
// bridge picks up the change.
import config from "../../config.js";
import * as registry from "../../server/accountRegistry.js";
import type { CommandContext, CommandHandler } from "../command/CommandContext.js";

async function handleModel({
  chatId,
  args,
  folderPath = config.dataDir,
  sock,
  repos,
}: CommandContext): Promise<void> {
  const models = repos!.model.getAllActiveModels();

  if (!args || !args.trim()) {
    const currentModelId = repos!.model.getLlm2Model(chatId);
    const defaultModel = repos!.model.getDefaultLlm2Model();
    const activeId = currentModelId || defaultModel?.modelId || null;
    const lines = models.map(
      (m) =>
        `- \`${m.modelId}\`${m.modelId === activeId ? " ✓" : ""} — ${m.displayName}${m.visionSupport ? " 👁" : ""}`,
    );
    try {
      await sock.sendMessage(chatId, {
        text:
          `Current model: *${activeId || "default"}*\n\n` +
          "Usage: `/model` <id>\n\n" +
          `Available models:\n${lines.join("\n") || "(none configured)"}`,
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const id = args.trim();
  const model = models.find((m) => m.modelId === id);
  if (!model) {
    try {
      await sock.sendMessage(chatId, {
        text: `Unknown model id: ${id}. Run \`/model\` to list available models.`,
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  repos!.model.setLlm2Model(chatId, id);
  registry.sendReliableToClient(folderPath, {
    type: "set_llm2_model",
    folderPath,
    chatId,
    modelId: id,
  });
  registry.sendReliableToClient(folderPath, {
    type: "invalidate_llm2_model",
    folderPath,
    chatId,
  });

  try {
    await sock.sendMessage(chatId, {
      text: `Model changed to: ${model.displayName}${model.visionSupport ? " (Vision)" : ""}`,
    });
  } catch (err) {
    /* ignore */
  }
}

export { handleModel };

export const modelCommand: CommandHandler = {
  commands: ["model"],
  description:
    "List or set the LLM model for this chat. Without arguments it lists the available models (the current one marked ✓); with an id it switches this chat to that model. Example: /model gpt-4o.",
  permission: "isPrivate or isAdmin or isOwner",
  run: (_sock, _message, ctx) => handleModel(ctx),
};
