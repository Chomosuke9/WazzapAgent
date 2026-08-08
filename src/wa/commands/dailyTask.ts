import { randomUUID } from "crypto";
import config from "../../config.js";
import * as registry from "../../server/accountRegistry.js";
import type { CommandContext, CommandHandler } from "../command/CommandContext.js";
import { rewritePromptMentions } from "./prompt.js";

/** Parse and canonicalize a 24-hour HH:MM token. */
export function parseDailyTime(token: string): string | null {
  const match = (token || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

const USAGE =
  "🔁 *Daily task*\n\n" +
  "Commands:\n" +
  "`/daily-task` — show this chat's daily tasks\n" +
  "`/daily-task add <HH:MM> <prompt>` — add a task\n" +
  "`/daily-task delete <taskId>` — delete a task shown in the list\n\n" +
  "Time uses the bot context timezone (`CONTEXT_TIME_UTC_OFFSET_HOURS`; server local time when unset).\n\n" +
  "Example:\n" +
  "_/daily-task add 08:00 Remind @Budi (abc123) to submit the report_\n\n" +
  "Use the `@Name (senderRef)` format in LLM-generated prompts; human WhatsApp mentions are converted automatically.";

export async function handleDailyTask(ctx: CommandContext): Promise<void> {
  const { chatId, args, folderPath = config.dataDir, sock, account, msg } = ctx;
  const trimmed = (args || "").trim();

  // The bare command is intentionally a list operation: the bridge owns the
  // persistent records, so it can show the current IDs and prompts accurately.
  if (!trimmed) {
    registry.sendReliableToClient(folderPath, {
      type: "daily_task_list",
      folderPath,
      chatId,
    });
    return;
  }

  const commandEnd = trimmed.search(/\s/);
  const action = (commandEnd === -1 ? trimmed : trimmed.slice(0, commandEnd)).toLowerCase();
  const remainder = commandEnd === -1 ? "" : trimmed.slice(commandEnd + 1).trim();

  if (action === "delete") {
    // The list exposes an eight-character ID prefix. The bridge resolves it
    // within this chat, so one chat can never delete another chat's task.
    if (!remainder || /\s/.test(remainder)) {
      try {
        await sock.sendMessage(chatId, { text: USAGE });
      } catch {
        /* ignore */
      }
      return;
    }
    registry.sendReliableToClient(folderPath, {
      type: "daily_task_delete",
      folderPath,
      chatId,
      taskId: remainder,
    });
    return;
  }

  if (action !== "add") {
    try {
      await sock.sendMessage(chatId, { text: USAGE });
    } catch {
      /* ignore */
    }
    return;
  }

  const spaceIdx = remainder.search(/\s/);
  const timeToken = spaceIdx === -1 ? remainder : remainder.slice(0, spaceIdx);
  let prompt = spaceIdx === -1 ? "" : remainder.slice(spaceIdx + 1).trim();
  const timeOfDay = parseDailyTime(timeToken);

  if (!timeOfDay || !prompt) {
    try {
      await sock.sendMessage(chatId, { text: USAGE });
    } catch {
      /* ignore */
    }
    return;
  }

  if (account) {
    try {
      prompt = await rewritePromptMentions(account, chatId, prompt, msg);
    } catch {
      /* best effort: keep the original prompt */
    }
  }

  const taskId = randomUUID();
  registry.sendReliableToClient(folderPath, {
    type: "daily_task",
    folderPath,
    chatId,
    taskId,
    timeOfDay,
    prompt,
  });

  try {
    await sock.sendMessage(chatId, {
      text: `🔁 Daily task scheduled for ${timeOfDay}. ID: ${taskId.slice(0, 8)}.`,
    });
  } catch {
    /* ignore */
  }
}

export const dailyTaskCommand: CommandHandler = {
  commands: ["daily-task"],
  description:
    "List, add, or delete recurring daily tasks. Use /daily-task, /daily-task add <HH:MM> <prompt>, or /daily-task delete <taskId>.",
  permission: "public",
  run: (_sock, _message, ctx) => handleDailyTask(ctx),
};
