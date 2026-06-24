// Shared base for the per-domain repository classes (Step 04 structural split).
//
// Each repository takes a `Database` (the connection-owner from Step 03) via
// its constructor and operates on that instance's `DbState`s. The low-level
// query helpers (`runSettingsQuery`, `getOneFromState`, `getAllFromState`),
// the readiness guard (`ensureSettingsDbReady`), and the two chat_settings
// helpers shared by SettingsRepository and ModelRepository (`ensureChatRow`,
// `getSettingRow`) were lifted VERBATIM from the old src/db.ts module-level
// helpers — no SQL or behavior changed. Only the per-domain module-global DB
// state became `this.db.settingsState` / `this.db`.

import {
  Database,
  withDbRecovery,
} from "../Database.js";
import type { SqliteDb, DbState } from "../Database.js";
import { GLOBAL_CHAT_ID, initSettingsTables } from "../schema/index.js";

// ---------------------------------------------------------------------------
// Row shape shared by the chat_settings helpers (per
// docs/llm-architecture/05-state-data-and-db.md)
// ---------------------------------------------------------------------------

export interface ChatSettingsRow {
  chat_id: string;
  prompt: string | null;
  permission: number;
  mode: string;
  triggers: string;
  llm2_model: string | null;
  subagent_enabled: number;
  idle_trigger_min: number | null;
  idle_trigger_max: number | null;
  announcement_enabled: number;
  compatibility_mode: string;
  auto_device: string | null;
  updated_at: string;
}

export abstract class BaseRepository {
  protected readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  protected get settingsState(): DbState {
    return this.db.settingsState;
  }

  protected runSettingsQuery(sql: string, ...params: unknown[]): void {
    return withDbRecovery(this.settingsState, initSettingsTables, () =>
      this.settingsState.db!.run(sql, params),
    );
  }

  protected getOneFromState<T = Record<string, unknown>>(
    state: DbState,
    initTablesFn: (db: SqliteDb) => void,
    sql: string,
    ...params: unknown[]
  ): T | null {
    return withDbRecovery(state, initTablesFn, () => {
      const stmt = state.db!.prepare(sql);
      stmt.bind(params);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return row as T;
      }
      stmt.free();
      return null;
    });
  }

  protected getAllFromState<T = Record<string, unknown>>(
    state: DbState,
    initTablesFn: (db: SqliteDb) => void,
    sql: string,
    ...params: unknown[]
  ): T[] {
    return withDbRecovery(state, initTablesFn, () => {
      const stmt = state.db!.prepare(sql);
      stmt.bind(params);
      const results: T[] = [];
      while (stmt.step()) {
        results.push(stmt.getAsObject() as T);
      }
      stmt.free();
      return results;
    });
  }

  protected ensureChatRow(chatId: string): void {
    if (chatId === GLOBAL_CHAT_ID) return;
    // Use INSERT OR IGNORE to avoid UNIQUE constraint violations when concurrent
    // workers (Node + Python) both observe the row is missing and try to insert.
    this.runSettingsQuery(
      `INSERT OR IGNORE INTO chat_settings
        (chat_id, prompt, permission, mode, triggers, llm2_model,
         subagent_enabled, idle_trigger_min, idle_trigger_max, announcement_enabled, compatibility_mode, updated_at)
      SELECT ?, prompt, permission, mode, triggers, llm2_model,
             subagent_enabled, idle_trigger_min, idle_trigger_max, announcement_enabled, compatibility_mode, datetime('now')
      FROM chat_settings WHERE chat_id = ?`,
      chatId,
      GLOBAL_CHAT_ID,
    );
  }

  protected getSettingRow(chatId: string): ChatSettingsRow | null {
    let row = this.getOneFromState<ChatSettingsRow>(
      this.settingsState,
      initSettingsTables,
      "SELECT * FROM chat_settings WHERE chat_id = ?",
      chatId,
    );
    if (!row) {
      row = this.getOneFromState<ChatSettingsRow>(
        this.settingsState,
        initSettingsTables,
        "SELECT * FROM chat_settings WHERE chat_id = ?",
        GLOBAL_CHAT_ID,
      );
    }
    return row;
  }

  protected ensureSettingsDbReady(): void {
    if (!this.settingsState.db) {
      throw new Error("Settings DB not initialized");
    }
  }
}
