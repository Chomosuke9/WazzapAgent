// Chat settings domain: mode / prompt / permission / trigger / idle /
// announcement, the per-chat + global setters, owner-contact, and the
// subagent-enabled flag (which lives on the chat_settings row). Folded the
// tiny owner-contact / idle / announcement / global-settings domains in here
// per the step-04 spec ("do not create one-method classes gratuitously").
//
// Every method + its SQL is VERBATIM from the old src/db.ts; only the
// per-domain module-global DB state became `this`-based helpers from
// BaseRepository.

import logger from "../../logger.js";
import {
  DEFAULT_MODE,
  DEFAULT_TRIGGERS,
  GLOBAL_CHAT_ID,
  initSettingsTables,
} from "../schema/index.js";
import { BaseRepository } from "./BaseRepository.js";

interface OwnerContactRow {
  id: number;
  phone_number: string;
  display_name: string;
  updated_at: string;
}

interface OwnerContactInfo {
  phoneNumber: string;
  displayName: string;
}

interface IdleTrigger {
  min: number;
  max: number;
}

export const VALID_MODES = new Set(["auto", "prefix", "hybrid"]);
export const VALID_TRIGGERS = new Set(["tag", "tagall", "reply", "join", "name"]);

export class SettingsRepository extends BaseRepository {
  getPrompt(chatId: string): string | null {
    const row = this.getSettingRow(chatId);
    return row?.prompt ?? null;
  }

  setPrompt(chatId: string, prompt: string | null): void {
    this.ensureChatRow(chatId);
    this.runSettingsQuery(
      "UPDATE chat_settings SET prompt = ?, updated_at = datetime('now') WHERE chat_id = ?",
      prompt,
      chatId,
    );
    logger.info({ chatId, promptLen: prompt?.length || 0 }, "DB set_prompt");
  }

  getPermission(chatId: string): number {
    const row = this.getSettingRow(chatId);
    return row?.permission ?? 0;
  }

  setPermission(chatId: string, level: number | string): void {
    const clamped = Math.max(0, Math.min(3, parseInt(level as string, 10) || 0));
    this.ensureChatRow(chatId);
    this.runSettingsQuery(
      "UPDATE chat_settings SET permission = ?, updated_at = datetime('now') WHERE chat_id = ?",
      clamped,
      chatId,
    );
    logger.info({ chatId, level: clamped }, "DB set_permission");
  }

  getMode(chatId: string): string {
    const row = this.getSettingRow(chatId);
    let value = row?.mode ?? DEFAULT_MODE;
    if (!VALID_MODES.has(value)) value = DEFAULT_MODE;
    return value;
  }

  setMode(chatId: string, mode: string): void {
    if (!VALID_MODES.has(mode)) mode = DEFAULT_MODE;
    this.ensureChatRow(chatId);
    this.runSettingsQuery(
      "UPDATE chat_settings SET mode = ?, updated_at = datetime('now') WHERE chat_id = ?",
      mode,
      chatId,
    );
    logger.info({ chatId, mode }, "DB set_mode");
  }

  getTriggers(chatId: string): Set<string> {
    const row = this.getSettingRow(chatId);
    const raw = row?.triggers ?? DEFAULT_TRIGGERS;
    return new Set(
      raw
        .split(",")
        .filter((t) => VALID_TRIGGERS.has(t.trim().toLowerCase()))
        .map((t) => t.trim().toLowerCase()),
    );
  }

  setTriggers(chatId: string, triggers: Iterable<string>): void {
    const valid = [...triggers].filter((t) => VALID_TRIGGERS.has(t));
    const raw = valid.sort().join(",") || "";
    this.ensureChatRow(chatId);
    this.runSettingsQuery(
      "UPDATE chat_settings SET triggers = ?, updated_at = datetime('now') WHERE chat_id = ?",
      raw,
      chatId,
    );
    logger.info({ chatId, triggers: raw }, "DB set_triggers");
  }

  clearSettings(chatId: string): void {
    this.runSettingsQuery("DELETE FROM chat_settings WHERE chat_id = ?", chatId);
    logger.info({ chatId }, "DB clear_settings");
  }

  getOwnerContact(): OwnerContactInfo | null {
    const row = this.getOneFromState<
      Pick<OwnerContactRow, "phone_number" | "display_name">
    >(
      this.settingsState,
      initSettingsTables,
      "SELECT phone_number, display_name FROM owner_contact WHERE id = 1",
    );
    if (!row) return null;
    return { phoneNumber: row.phone_number, displayName: row.display_name };
  }

  setOwnerContact(phoneNumber: string, displayName: string): void {
    this.runSettingsQuery(
      `
    INSERT INTO owner_contact (id, phone_number, display_name, updated_at)
    VALUES (1, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      phone_number = excluded.phone_number,
      display_name = excluded.display_name,
      updated_at = excluded.updated_at
  `,
      phoneNumber,
      displayName,
    );
    logger.info({ phoneNumber, displayName }, "DB set_owner_contact");
  }

  // -------------------------------------------------------------------------
  // Bot-wide owner-only config (bot_config key/value)
  // -------------------------------------------------------------------------

  getBotConfig(key: string): string | null {
    const row = this.getOneFromState<{ value: string | null }>(
      this.settingsState,
      initSettingsTables,
      "SELECT value FROM bot_config WHERE key = ?",
      key,
    );
    return row?.value ?? null;
  }

  setBotConfig(key: string, value: string | null): void {
    if (value === null) {
      this.runSettingsQuery("DELETE FROM bot_config WHERE key = ?", key);
      logger.info({ key }, "DB bot_config_clear");
      return;
    }
    this.runSettingsQuery(
      `INSERT INTO bot_config (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
    );
    logger.info({ key }, "DB bot_config_set");
  }

  getSubagentEnabled(chatId: string): boolean {
    const row = this.getSettingRow(chatId);
    return row?.subagent_enabled === 1;
  }

  setSubagentEnabled(chatId: string, enabled: boolean): void {
    const value = enabled ? 1 : 0;
    this.ensureChatRow(chatId);
    this.runSettingsQuery(
      "UPDATE chat_settings SET subagent_enabled = ?, updated_at = datetime('now') WHERE chat_id = ?",
      value,
      chatId,
    );
    logger.info({ chatId, enabled: value }, "DB set_subagent_enabled");
  }

  setGlobalPrompt(prompt: string | null): void {
    this.runSettingsQuery(
      "UPDATE chat_settings SET prompt = ?, updated_at = datetime('now')",
      prompt,
    );
    logger.info({ promptLen: prompt?.length || 0 }, "DB set_global_prompt");
  }

  setGlobalPermission(level: number | string): void {
    const clamped = Math.max(0, Math.min(3, parseInt(level as string, 10) || 0));
    this.runSettingsQuery(
      "UPDATE chat_settings SET permission = ?, updated_at = datetime('now')",
      clamped,
    );
    logger.info({ level: clamped }, "DB set_global_permission");
  }

  setGlobalMode(mode: string): void {
    if (!VALID_MODES.has(mode)) mode = DEFAULT_MODE;
    this.runSettingsQuery(
      "UPDATE chat_settings SET mode = ?, updated_at = datetime('now')",
      mode,
    );
    logger.info({ mode }, "DB set_global_mode");
  }

  setGlobalTriggers(triggers: Iterable<string>): void {
    const valid = [...triggers].filter((t) => VALID_TRIGGERS.has(t));
    const raw = valid.sort().join(",") || "";
    this.runSettingsQuery(
      "UPDATE chat_settings SET triggers = ?, updated_at = datetime('now')",
      raw,
    );
    logger.info({ triggers: raw }, "DB set_global_triggers");
  }

  setGlobalSubagentEnabled(enabled: boolean): void {
    const value = enabled ? 1 : 0;
    this.runSettingsQuery(
      "UPDATE chat_settings SET subagent_enabled = ?, updated_at = datetime('now')",
      value,
    );
    logger.info({ enabled: value }, "DB set_global_subagent_enabled");
  }

  // -------------------------------------------------------------------------
  // Default (fallback) setters — write ONLY the __global__ row.
  //
  // Semantics (feature 3): `default` changes the value used by chats that have
  // NOT been touched yet (no per-chat row → reads fall back to __global__ via
  // BaseRepository.getSettingRow). Chats with their own row keep their value.
  // Contrast with the setGlobal* setters above, which overwrite EVERY row.
  // -------------------------------------------------------------------------

  private ensureGlobalRow(): void {
    this.runSettingsQuery(
      "INSERT OR IGNORE INTO chat_settings (chat_id) VALUES (?)",
      GLOBAL_CHAT_ID,
    );
  }

  setDefaultPrompt(prompt: string | null): void {
    this.ensureGlobalRow();
    this.runSettingsQuery(
      "UPDATE chat_settings SET prompt = ?, updated_at = datetime('now') WHERE chat_id = ?",
      prompt,
      GLOBAL_CHAT_ID,
    );
    logger.info({ promptLen: prompt?.length || 0 }, "DB set_default_prompt");
  }

  setDefaultPermission(level: number | string): void {
    const clamped = Math.max(0, Math.min(3, parseInt(level as string, 10) || 0));
    this.ensureGlobalRow();
    this.runSettingsQuery(
      "UPDATE chat_settings SET permission = ?, updated_at = datetime('now') WHERE chat_id = ?",
      clamped,
      GLOBAL_CHAT_ID,
    );
    logger.info({ level: clamped }, "DB set_default_permission");
  }

  setDefaultMode(mode: string): void {
    if (!VALID_MODES.has(mode)) mode = DEFAULT_MODE;
    this.ensureGlobalRow();
    this.runSettingsQuery(
      "UPDATE chat_settings SET mode = ?, updated_at = datetime('now') WHERE chat_id = ?",
      mode,
      GLOBAL_CHAT_ID,
    );
    logger.info({ mode }, "DB set_default_mode");
  }

  setDefaultTriggers(triggers: Iterable<string>): void {
    const valid = [...triggers].filter((t) => VALID_TRIGGERS.has(t));
    const raw = valid.sort().join(",") || "";
    this.ensureGlobalRow();
    this.runSettingsQuery(
      "UPDATE chat_settings SET triggers = ?, updated_at = datetime('now') WHERE chat_id = ?",
      raw,
      GLOBAL_CHAT_ID,
    );
    logger.info({ triggers: raw }, "DB set_default_triggers");
  }

  setDefaultIdleTrigger(min: number | null, max: number | null): void {
    this.ensureGlobalRow();
    this.runSettingsQuery(
      "UPDATE chat_settings SET idle_trigger_min = ?, idle_trigger_max = ?, updated_at = datetime('now') WHERE chat_id = ?",
      min,
      max,
      GLOBAL_CHAT_ID,
    );
    logger.info({ min, max }, "DB set_default_idle_trigger");
  }

  setDefaultAnnouncementEnabled(enabled: boolean): void {
    const value = enabled ? 1 : 0;
    this.ensureGlobalRow();
    this.runSettingsQuery(
      "UPDATE chat_settings SET announcement_enabled = ?, updated_at = datetime('now') WHERE chat_id = ?",
      value,
      GLOBAL_CHAT_ID,
    );
    logger.info({ enabled: value }, "DB set_default_announcement_enabled");
  }

  setDefaultSubagentEnabled(enabled: boolean): void {
    const value = enabled ? 1 : 0;
    this.ensureGlobalRow();
    this.runSettingsQuery(
      "UPDATE chat_settings SET subagent_enabled = ?, updated_at = datetime('now') WHERE chat_id = ?",
      value,
      GLOBAL_CHAT_ID,
    );
    logger.info({ enabled: value }, "DB set_default_subagent_enabled");
  }

  getIdleTrigger(chatId: string): IdleTrigger | null {
    const row = this.getSettingRow(chatId);
    const min = row?.idle_trigger_min ?? null;
    const max = row?.idle_trigger_max ?? null;
    if (min == null) return null;
    return { min, max: max ?? min };
  }

  setIdleTrigger(
    chatId: string,
    min: number | null,
    max: number | null,
  ): void {
    this.ensureChatRow(chatId);
    this.runSettingsQuery(
      "UPDATE chat_settings SET idle_trigger_min = ?, idle_trigger_max = ?, updated_at = datetime('now') WHERE chat_id = ?",
      min,
      max,
      chatId,
    );
    logger.info({ chatId, min, max }, "DB set_idle_trigger");
  }

  setGlobalIdleTrigger(min: number | null, max: number | null): void {
    this.runSettingsQuery(
      "UPDATE chat_settings SET idle_trigger_min = ?, idle_trigger_max = ?, updated_at = datetime('now')",
      min,
      max,
    );
    logger.info({ min, max }, "DB set_global_idle_trigger");
  }

  getAnnouncementEnabled(chatId: string): boolean {
    const row = this.getSettingRow(chatId);
    return row?.announcement_enabled !== 0;
  }

  setAnnouncementEnabled(chatId: string, enabled: boolean): void {
    const value = enabled ? 1 : 0;
    this.ensureChatRow(chatId);
    this.runSettingsQuery(
      "UPDATE chat_settings SET announcement_enabled = ?, updated_at = datetime('now') WHERE chat_id = ?",
      value,
      chatId,
    );
    logger.info({ chatId, enabled: value }, "DB set_announcement_enabled");
  }

  setGlobalAnnouncementEnabled(enabled: boolean): void {
    const value = enabled ? 1 : 0;
    this.runSettingsQuery(
      "UPDATE chat_settings SET announcement_enabled = ?, updated_at = datetime('now')",
      value,
    );
    logger.info({ enabled: value }, "DB set_global_announcement_enabled");
  }

  // -------------------------------------------------------------------------
  // Long-term memory (/memory command)
  //
  // Memory is an ordered list per `scope_key` (the chat JID, or __global__ for
  // the shared list every chat sees). The stored `text` holds mentions in the
  // canonical `@Name (senderRef)` form; the stable LID behind each senderRef is
  // persisted separately in `memory_mentions` so the outbound renderer can
  // re-register the senderRef->JID mapping without a WhatsApp metadata refetch
  // (see renderOutboundMentions). Both tables live in the shared settings.db.
  // -------------------------------------------------------------------------

  /** Append a memory entry to a scope. */
  addMemory(scopeKey: string, text: string): void {
    this.runSettingsQuery(
      "INSERT INTO memories (scope_key, text, created_at) VALUES (?, ?, datetime('now'))",
      scopeKey,
      text,
    );
    logger.info({ scopeKey, len: text.length }, "DB add_memory");
  }

  /** List a scope's memory entries, oldest first (1-based display order). */
  listMemories(scopeKey: string): { id: number; text: string }[] {
    return this.getAllFromState<{ id: number; text: string }>(
      this.settingsState,
      initSettingsTables,
      "SELECT id, text FROM memories WHERE scope_key = ? ORDER BY id ASC",
      scopeKey,
    );
  }

  /** Number of memory entries in a scope. */
  countMemories(scopeKey: string): number {
    const row = this.getOneFromState<{ n: number }>(
      this.settingsState,
      initSettingsTables,
      "SELECT COUNT(*) AS n FROM memories WHERE scope_key = ?",
      scopeKey,
    );
    return row?.n ?? 0;
  }

  /**
   * Delete the entry at a 1-based index (oldest-first) within a scope.
   * Returns the deleted entry's text, or null if the index was out of range.
   */
  deleteMemoryByIndex(scopeKey: string, index: number): string | null {
    if (!Number.isInteger(index) || index < 1) return null;
    const row = this.getOneFromState<{ id: number; text: string }>(
      this.settingsState,
      initSettingsTables,
      "SELECT id, text FROM memories WHERE scope_key = ? ORDER BY id ASC LIMIT 1 OFFSET ?",
      scopeKey,
      index - 1,
    );
    if (!row) return null;
    this.runSettingsQuery("DELETE FROM memories WHERE id = ?", row.id);
    logger.info({ scopeKey, index }, "DB delete_memory");
    return row.text;
  }

  /** Persist (UPSERT) the stable LID behind a senderRef used in memory text. */
  upsertMemoryMention(scopeKey: string, senderRef: string, lid: string): void {
    if (!senderRef || !lid) return;
    this.runSettingsQuery(
      `INSERT INTO memory_mentions (scope_key, sender_ref, lid, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(scope_key, sender_ref) DO UPDATE SET
         lid = excluded.lid, updated_at = excluded.updated_at`,
      scopeKey,
      senderRef,
      lid,
    );
  }

  /**
   * Resolve the stable LID for a senderRef from persisted memory-mention
   * bindings, preferring the chat-scoped binding over the shared global one.
   * Returns null if no binding exists.
   */
  getMemoryMentionLid(chatId: string, senderRef: string): string | null {
    if (!chatId || !senderRef) return null;
    const row = this.getOneFromState<{ lid: string }>(
      this.settingsState,
      initSettingsTables,
      `SELECT lid FROM memory_mentions
       WHERE sender_ref = ? AND scope_key IN (?, ?)
       ORDER BY (scope_key = ?) DESC
       LIMIT 1`,
      senderRef,
      chatId,
      GLOBAL_CHAT_ID,
      chatId,
    );
    return row?.lid ?? null;
  }

  // -------------------------------------------------------------------------
  // Live participant-name roster (participant_names) — keyed by
  // (chat_id, sender_ref). Backs live re-rendering of `@Name (senderRef)`
  // mentions in stored /memory & /prompt text: the gateway keeps the name
  // current on every inbound message, and the Python bridge swaps the baked
  // name for this one at prompt-build time.
  // -------------------------------------------------------------------------

  /** UPSERT the current display name for a (chat, senderRef). */
  upsertParticipantName(chatId: string, senderRef: string, name: string): void {
    if (!chatId || !senderRef || !name) return;
    this.runSettingsQuery(
      `INSERT INTO participant_names (chat_id, sender_ref, name, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(chat_id, sender_ref) DO UPDATE SET
         name = excluded.name, updated_at = excluded.updated_at`,
      chatId,
      senderRef,
      name,
    );
  }

  /** Current display name for a (chat, senderRef), or null if not yet known. */
  getParticipantName(chatId: string, senderRef: string): string | null {
    if (!chatId || !senderRef) return null;
    const row = this.getOneFromState<{ name: string }>(
      this.settingsState,
      initSettingsTables,
      "SELECT name FROM participant_names WHERE chat_id = ? AND sender_ref = ?",
      chatId,
      senderRef,
    );
    return row?.name ?? null;
  }
}
