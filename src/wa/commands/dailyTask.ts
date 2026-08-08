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
  "Format: `/daily-task <HH:MM> <prompt>`\n" +
  "Time uses the bot context timezone (`CONTEXT_TIME_UTC_OFFSET_HOURS`; server local time when unset).\n\n" +
  "Example:\n" +
  "_/daily-task 08:00 Remind @Budi (abc123) to submit the report_\n\n" +
  "Use the `@Name (senderRef)` format in LLM-generated prompts; human WhatsApp mentions are converted automatically.";

export async function handleDailyTask(ctx: CommandContext): Promise<void> {
  const { chatId, args, folderPath = config.dataDir, sock, account, msg } = ctx;
  const trimmed = (args || "").trim();
  const spaceIdx = trimmed.search(/\s/);
  const timeToken = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  let prompt = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
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
      text: `🔁 Daily task scheduled for ${timeOfDay}.`,
    });
  } catch {
    /* ignore */
  }
}

export const dailyTaskCommand: CommandHandler = {
  commands: ["daily-task"],
  description:
    "Run a recurring task every day. Format: /daily-task <HH:MM> <prompt>. Example: /daily-task 08:00 Remind @Budi (abc123) to submit the report.",
  permission: "public",
  run: (_sock, _message, ctx) => handleDailyTask(ctx),
};
