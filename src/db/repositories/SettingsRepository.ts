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
export const VALID_TRIGGERS = new Set(["tag", "reply", "join", "name"]);

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
}
