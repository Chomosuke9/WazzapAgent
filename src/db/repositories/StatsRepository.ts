// Dashboard stats domain (read accessors over stats.db).
//
// Methods + SQL are VERBATIM from the old src/db.ts; per-domain module state became
// `this.db.statsState`.

import { initStatsTables } from "../schema/index.js";
import { BaseRepository } from "./BaseRepository.js";

interface ChatStatsRow {
  stat_key: string;
  stat_value: number;
}

interface ChatUserStatsRow {
  sender_ref: string;
  sender_name: string;
  invoke_count: number;
}

interface TopUser {
  senderRef: string;
  senderName: string;
  invokeCount: number;
}

export class StatsRepository extends BaseRepository {
  getStats(
    chatId: string,
    periodType: string,
    periodKey: string,
  ): Record<string, number> {
    const rows = this.getAllFromState<ChatStatsRow>(
      this.db.statsState,
      initStatsTables,
      "SELECT stat_key, stat_value FROM chat_stats WHERE chat_id = ? AND period_type = ? AND period_key = ?",
      chatId,
      periodType,
      periodKey,
    );
    const result: Record<string, number> = {};
    for (const row of rows) result[row.stat_key] = row.stat_value;
    return result;
  }

  getTopUsers(
    chatId: string,
    periodType: string,
    periodKey: string,
    limit = 5,
  ): TopUser[] {
    const rows = this.getAllFromState<ChatUserStatsRow>(
      this.db.statsState,
      initStatsTables,
      `SELECT sender_ref, sender_name, invoke_count FROM chat_user_stats
     WHERE chat_id = ? AND period_type = ? AND period_key = ?
     ORDER BY invoke_count DESC LIMIT ?`,
      chatId,
      periodType,
      periodKey,
      limit,
    );
    return rows.map((row) => ({
      senderRef: row.sender_ref,
      senderName: row.sender_name,
      invokeCount: row.invoke_count,
    }));
  }
}
