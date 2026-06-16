import { proto, generateWAMessageFromContent } from "baileys";
import logger from "../../logger.js";
import { withJidQueue } from "../sendQueue.js";
import type { WaSocketLike } from "../../protocol/ports.js";
import type {
  CommandContext,
  CommandHandler,
} from "../command/CommandContext.js";

/**
 * ISO-8601 week key, formatted as `YYYY-Www` to match the keys the Python
 * bridge writes (`bridge/dashboard.py` uses `now.isocalendar()` →
 * `f"{iso_year}-W{iso_week:02d}"`). A Monday-date key (`YYYY-MM-DD`) would never
 * match a written row — daily (`YYYY-MM-DD`) and monthly (`YYYY-MM`) already do.
 */
function getWeekKey(date: Date): string {
  // Operate on the UTC calendar date (consistent with the daily/monthly keys,
  // which derive from `toISOString()`).
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  // Shift to the Thursday of this week — the ISO week's year/number are defined
  // by the week's Thursday. Day index Mon=0..Sun=6.
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const isoYear = d.getUTCFullYear();
  // Thursday of ISO week 1 is the Thursday in the week containing Jan 4.
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const weekNo =
    1 +
    Math.round(
      (d.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000),
    );
  return `${isoYear}-W${String(weekNo).padStart(2, "0")}`;
}

/**
 * Render a leaderboard as a WhatsApp `pollResultSnapshotMessage`. WhatsApp draws
 * this as a titled list of options with horizontal vote bars.
 *
 * `pollResultSnapshotMessage` is not accepted by `sock.sendMessage` (same as
 * interactive/lottie content), so it is built with `generateWAMessageFromContent`
 * and pushed through `relayMessage` — mirroring the existing relay paths
 * (`src/wa/interactive/sendInteractive.ts`, `src/wa/outbound.ts`).
 */
async function sendPollResultSnapshot(
  sock: WaSocketLike,
  jid: string,
  name: string,
  votes: Array<{ optionName: string; optionVoteCount: number }>,
): Promise<void> {
  const content = {
    pollResultSnapshotMessage: proto.Message.PollResultSnapshotMessage.create({
      name,
      pollType: proto.Message.PollType.POLL,
      pollVotes: votes.map((v) =>
        proto.Message.PollResultSnapshotMessage.PollVote.create({
          optionName: v.optionName,
          optionVoteCount: v.optionVoteCount,
        }),
      ),
    }),
  };

  const msg = generateWAMessageFromContent(jid, content, {
    userJid: sock.user!.id,
  });
  await sock.relayMessage(jid, msg.message!, { messageId: msg.key.id! });
}

/** Plain-text dashboard — robust fallback used when the poll-snapshot relay
 *  fails. Preserves the full numeric breakdown. */
async function sendTextDashboard(
  { chatId, sock }: CommandContext,
  daily: Record<string, number>,
  weekly: Record<string, number>,
  monthly: Record<string, number>,
  topUsers: Array<{
    senderRef: string;
    senderName: string;
    invokeCount: number;
  }>,
  dailyKey: string,
  weekKey: string,
  monthKey: string,
): Promise<void> {
  const lines = ["*Dashboard Stats*"];
  lines.push("");
  lines.push("*Statistic (This Month)*");
  lines.push(`  Router calls: ${monthly.llm1_calls || 0}`);
  lines.push(`  Main agent calls: ${monthly.llm2_calls || 0}`);
  lines.push(
    `  Sub-agent tasks completed: ${monthly.subagent_tasks_completed || 0}`,
  );
  lines.push("");
  lines.push(`*Daily (${dailyKey})*`);
  lines.push(`  Messages processed: ${daily.messages_processed || 0}`);
  lines.push(`  Responses sent: ${daily.responses_sent || 0}`);
  lines.push("");
  lines.push(`*Weekly (${weekKey})*`);
  lines.push(`  Messages processed: ${weekly.messages_processed || 0}`);
  lines.push(`  Responses sent: ${weekly.responses_sent || 0}`);
  lines.push("");
  lines.push(`*Monthly (${monthKey})*`);
  lines.push(`  Messages processed: ${monthly.messages_processed || 0}`);
  lines.push(`  Responses sent: ${monthly.responses_sent || 0}`);

  if (topUsers.length > 0) {
    lines.push("");
    lines.push("*Top Monthly Users*");
    for (const u of topUsers) {
      lines.push(`  ${u.senderName || u.senderRef}: ${u.invokeCount}`);
    }
  }

  await sock.sendMessage(chatId, { text: lines.join("\n") });
}

async function handleDashboard(ctx: CommandContext): Promise<void> {
  const { chatId, sock, repos, account } = ctx;
  const now = new Date();
  const dailyKey = now.toISOString().slice(0, 10);
  const weekKey = getWeekKey(now);
  const monthKey = now.toISOString().slice(0, 7);

  const daily = repos!.stats.getStats(chatId, "daily", dailyKey);
  const weekly = repos!.stats.getStats(chatId, "weekly", weekKey);
  const monthly = repos!.stats.getStats(chatId, "monthly", monthKey);
  // WhatsApp polls render up to ~12 options; show the top 10 chatters.
  const topUsers = repos!.stats.getTopUsers(chatId, "monthly", monthKey, 10);
  // "Overall" baseline = sum of EVERY user's invocations this month (not just
  // the displayed top 10), so it reconciles with the per-user leaderboard rows.
  const totalUserInvokes = repos!.stats.getTotalUserInvokes(
    chatId,
    "monthly",
    monthKey,
  );

  // Serialize every send to this chat through the per-JID queue. Two un-queued
  // sends to the SAME jid race on Baileys' shared pending-ack map and WhatsApp
  // silently drops the second (see src/wa/sendQueue.ts) — which is exactly why
  // the dashboard's second message used to never appear. This is the same
  // pattern the action dispatcher and /broadcast use for reliable delivery.
  const send = <T>(fn: () => Promise<T>): Promise<T> =>
    account ? withJidQueue(account, chatId, fn) : fn();

  // --- Message 1: STATISTIC summary + DASHBOARD period-comparison poll. ---
  // The router / main-agent / sub-agent counters (monthly) live in the poll
  // title; the vote bars compare message volume across the three periods.
  const statisticTitle = [
    "📊 STATISTIC",
    `ROUTER CALL : ${monthly.llm1_calls || 0}`,
    `MAIN AGENT CALL : ${monthly.llm2_calls || 0}`,
    `SUB-AGENT TASK COMPLETED : ${monthly.subagent_tasks_completed || 0}`,
    "",
    "📊 DASHBOARD",
  ].join("\n");
  const periodVotes = [
    { optionName: "🕘 Today", optionVoteCount: daily.messages_processed || 0 },
    {
      optionName: "7️⃣ This Week",
      optionVoteCount: weekly.messages_processed || 0,
    },
    {
      optionName: "📆 This Month",
      optionVoteCount: monthly.messages_processed || 0,
    },
  ];

  try {
    await send(() =>
      sendPollResultSnapshot(sock, chatId, statisticTitle, periodVotes),
    );
  } catch (err) {
    // If the primary poll cannot be relayed, degrade to the full text dashboard.
    logger.warn(
      { err, chatId },
      "failed sending /dashboard poll snapshot; falling back to text",
    );
    try {
      await send(() =>
        sendTextDashboard(
          ctx,
          daily,
          weekly,
          monthly,
          topUsers,
          dailyKey,
          weekKey,
          monthKey,
        ),
      );
    } catch (e) {
      logger.warn(
        { err: e, chatId },
        "failed sending /dashboard text fallback",
      );
    }
    return;
  }

  // --- Message 2: Top Monthly Users leaderboard poll. ---
  // The first option is always "Overall" (total monthly interaction). This gives
  // the poll a baseline AND guarantees >= 2 options whenever at least one user is
  // active (a poll with < 2 options is invalid and WhatsApp drops it — which is
  // why a single-active-user chat rendered nothing before). Then the top chatters
  // (<= 10), for at most 11 options total. Data is sanitized/guarded because any
  // empty/duplicate optionName or non-integer count also invalidates the poll.
  const overallCount = Math.max(0, Math.trunc(Number(totalUserInvokes) || 0));
  const userVotes: Array<{ optionName: string; optionVoteCount: number }> = [
    { optionName: "Overall", optionVoteCount: overallCount },
  ];
  const seenNames = new Set<string>(["Overall"]);
  topUsers.forEach((u, i) => {
    const cleaned =
      (u.senderName || u.senderRef || "unknown").replace(/\s+/g, " ").trim().slice(0, 24) ||
      "unknown";
    let optionName = `${i + 1}. ${cleaned}`;
    while (seenNames.has(optionName)) optionName += " ";
    seenNames.add(optionName);
    const count = Math.max(0, Math.trunc(Number(u.invokeCount) || 0));
    userVotes.push({ optionName, optionVoteCount: count });
  });

  if (userVotes.length >= 2) {
    try {
      await send(() =>
        sendPollResultSnapshot(sock, chatId, "🏆 Top Monthly Users", userVotes),
      );
    } catch (err) {
      logger.warn({ err, chatId }, "failed sending /dashboard top-users poll");
    }
  } else {
    // Only the Overall entry (no active users) — a 1-option poll is invalid.
    const lines = [
      "🏆 *Top Monthly Users*",
      `Overall: ${overallCount}`,
      "(no active users yet)",
    ];
    try {
      await send(() => sock.sendMessage(chatId, { text: lines.join("\n") }));
    } catch (err) {
      logger.warn({ err, chatId }, "failed sending /dashboard top-users note");
    }
  }
}

export { handleDashboard };

export const dashboardCommand: CommandHandler = {
  commands: ["dashboard", "dashboards"],
  description: "Tampilkan statistik penggunaan bot untuk chat ini: jumlah pesan, respon bot, dan aktivitas pengguna dalam periode tertentu.",
  permission: "public",
  run: (_sock, _message, ctx) => handleDashboard(ctx),
};
