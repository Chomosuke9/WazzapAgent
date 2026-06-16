import { randomUUID } from "crypto";
import config from "../../config.js";
import * as registry from "../../server/accountRegistry.js";
import type { CommandContext, CommandHandler } from "../command/CommandContext.js";

// Feature 5 — `/schedule-task <nnHnnM> <prompt>`.
//
// Anyone may schedule a one-shot task. After the parsed delay elapses, the
// Python bridge re-invokes LLM2 with the prompt (always responding, no LLM1
// gating — same delivery path a finished sub-agent uses). The schedule is
// persisted by the bridge so it survives a gateway/bridge restart.
//
// The command behaves identically whether typed by a human or invoked silently
// by LLM2 via the `reply_message` `command` parameter (run_command) — the same
// handler runs in both cases.

/** Hard cap on the schedule delay: 30 days. */
const MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

export interface ParsedDuration {
  hours: number;
  minutes: number;
  totalMs: number;
}

/**
 * Parse an `<nnHnnM>` duration token (case-insensitive). Accepts combinations
 * such as `2H30M`, `2H`, `30M`, `45m`. The token must match
 * `^(\d+H)?(\d+M)?$` with at least one of H/M present and a positive total;
 * otherwise `null` is returned.
 */
export function parseScheduleDuration(token: string): ParsedDuration | null {
  if (!token) return null;
  const match = token.match(/^(?:(\d+)H)?(?:(\d+)M)?$/i);
  if (!match) return null;
  // Require at least one of the H / M components (reject the empty match).
  if (match[1] === undefined && match[2] === undefined) return null;
  const hours = match[1] !== undefined ? parseInt(match[1], 10) : 0;
  const minutes = match[2] !== undefined ? parseInt(match[2], 10) : 0;
  const totalMs = (hours * 60 + minutes) * 60 * 1000;
  if (totalMs <= 0) return null;
  return { hours, minutes, totalMs };
}

/** Human-friendly `Hh Mm` rendering for the confirmation reply. */
function formatDuration(hours: number, minutes: number): string {
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  return parts.join(" ") || "0m";
}

const USAGE =
  "⏰ *Jadwalkan tugas*\n\n" +
  "Format: `/schedule-task <durasi> <perintah>`\n" +
  "Durasi: gabungan jam (H) dan menit (M), mis. `2H30M`, `2H`, `30M`, `45m`.\n\n" +
  "Contoh:\n" +
  "_/schedule-task 2H30M Ingatkan @Budi (abc123) soal rapat_\n\n" +
  "Maksimal 30 hari. Gunakan format `@Nama (senderRef)` di perintah agar orang tertentu ikut ditag nanti.";

export async function handleScheduleTask(ctx: CommandContext): Promise<void> {
  const { chatId, args, folderPath = config.dataDir, sock } = ctx;
  const trimmed = (args || "").trim();

  // First whitespace-delimited token = duration; the rest = the prompt.
  const spaceIdx = trimmed.search(/\s/);
  const durationToken = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const prompt = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  const parsed = durationToken ? parseScheduleDuration(durationToken) : null;
  if (!parsed || !prompt) {
    try {
      await sock.sendMessage(chatId, { text: USAGE });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (parsed.totalMs > MAX_DELAY_MS) {
    try {
      await sock.sendMessage(chatId, {
        text: "Durasi maksimal adalah 30 hari. ❌",
      });
    } catch (err) {
      /* ignore */
    }
    return;
  }

  const taskId = randomUUID();
  const fireAtMs = Date.now() + parsed.totalMs;

  registry.sendReliableToClient(folderPath, {
    type: "schedule_task",
    folderPath,
    chatId,
    taskId,
    fireAtMs,
    prompt,
  });

  try {
    await sock.sendMessage(chatId, {
      text: `⏰ Task dijadwalkan dalam ${formatDuration(parsed.hours, parsed.minutes)}.`,
    });
  } catch (err) {
    /* ignore */
  }
}

export const scheduleTaskCommand: CommandHandler = {
  commands: ["schedule-task"],
  description:
    "Jadwalkan tugas untuk dijalankan bot setelah jeda waktu. Format: /schedule-task <durasi> <perintah> — durasi gabungan jam (H) dan menit (M) mis. 2H30M, 30M, 45m (maks 30 hari). Contoh: /schedule-task 2H30M Ingatkan @Budi (abc123) soal rapat.",
  permission: "public",
  run: (_sock, _message, ctx) => handleScheduleTask(ctx),
};
