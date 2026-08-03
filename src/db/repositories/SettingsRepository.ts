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

export interface LlmProviderConfig {
  llm1Model: string | null;
  llm1Endpoint: string | null;
  llm1ApiKey: string | null;
  llm1FallbackModel: string | null;
  llm1FallbackEndpoint: string | null;
  llm1FallbackApiKey: string | null;
  llm2Model: string | null;
  llm2Endpoint: string | null;
  llm2ApiKey: string | null;
  llm2FallbackModel: string | null;
  llm2FallbackEndpoint: string | null;
  llm2FallbackApiKey: string | null;
}

interface IdleTrigger {
  min: number;
  max: number;
}

export interface ChatSettingsInfo {
  chatId: string;
  prompt: string | null;
  permission: number;
  mode: string;
  triggers: string[];
  llm2Model: string | null;
  subagentEnabled: boolean;
  idleTriggerMin: number | null;
  idleTriggerMax: number | null;
  announcementEnabled: boolean;
  compatibilityMode: string;
  autoDevice: string | null;
  updatedAt: string;
}

export interface BotConfigInfo {
  key: string;
  value: string | null;
  updatedAt: string;
}

export interface ChatDirectoryInfo {
  chatId: string;
  displayName: string;
  chatType: "group" | "private";
  updatedAt: string;
}

export const VALID_MODES = new Set(["auto", "prefix", "hybrid"]);
export const VALID_TRIGGERS = new Set(["tag", "tagall", "reply", "join", "name"]);
export const VALID_COMPAT_MODES = new Set(["auto", "full", "semi", "safe"]);
export const DEFAULT_COMPAT_MODE = "auto";

export class SettingsRepository extends BaseRepository {
  private mapChatSettings(row: import("./BaseRepository.js").ChatSettingsRow): ChatSettingsInfo {
    return {
      chatId: row.chat_id,
      prompt: row.prompt,
      permission: row.permission,
      mode: row.mode,
      triggers: row.triggers
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      llm2Model: row.llm2_model,
      subagentEnabled: row.subagent_enabled === 1,
      idleTriggerMin: row.idle_trigger_min,
      idleTriggerMax: row.idle_trigger_max,
      announcementEnabled: row.announcement_enabled !== 0,
      compatibilityMode: row.compatibility_mode,
      autoDevice: row.auto_device,
      updatedAt: row.updated_at,
    };
  }

  /** Return only the chat's own row (no __global__ fallback). */
  getChatSettingsRecord(chatId: string): ChatSettingsInfo | null {
    const row = this.getOneFromState<import("./BaseRepository.js").ChatSettingsRow>(
      this.settingsState,
      initSettingsTables,
      "SELECT * FROM chat_settings WHERE chat_id = ?",
      chatId,
    );
    return row ? this.mapChatSettings(row) : null;
  }

  /** List every explicitly configured chat plus the __global__ defaults row. */
  listChatSettings(): ChatSettingsInfo[] {
    return this.getAllFromState<import("./BaseRepository.js").ChatSettingsRow>(
      this.settingsState,
      initSettingsTables,
      `SELECT * FROM chat_settings
       ORDER BY CASE WHEN chat_id = '__global__' THEN 0 ELSE 1 END, updated_at DESC`,
    ).map((row) => this.mapChatSettings(row));
  }

  getEffectiveChatSettings(chatId: string): ChatSettingsInfo | null {
    const row = this.getSettingRow(chatId);
    if (!row) return null;
    return { ...this.mapChatSettings(row), chatId };
  }

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

  // -------------------------------------------------------------------------
  // Compatibility mode (interactive-message gating) + auto-detected device.
  //
  // `compatibility_mode` is one of auto|full|semi|safe and is read ONLY by the
  // Node gateway (interactive sends all execute Node-side), so changing it
  // needs no Python invalidation. In `auto`, the effective tier derives from
  // `auto_device` — the last KNOWN device of the chat's audience, persisted by
  // inbound.ts (DM peer; group admin/owner). See wa/interactive/compat.ts.
  // -------------------------------------------------------------------------

  getCompatibilityMode(chatId: string): string {
    const row = this.getSettingRow(chatId);
    let value = row?.compatibility_mode ?? DEFAULT_COMPAT_MODE;
    if (!VALID_COMPAT_MODES.has(value)) value = DEFAULT_COMPAT_MODE;
    return value;
  }

  setCompatibilityMode(chatId: string, mode: string): void {
    if (!VALID_COMPAT_MODES.has(mode)) mode = DEFAULT_COMPAT_MODE;
    this.ensureChatRow(chatId);
    this.runSettingsQuery(
      "UPDATE chat_settings SET compatibility_mode = ?, updated_at = datetime('now') WHERE chat_id = ?",
      mode,
      chatId,
    );
    logger.info({ chatId, mode }, "DB set_compatibility_mode");
  }

  setGlobalCompatibilityMode(mode: string): void {
    if (!VALID_COMPAT_MODES.has(mode)) mode = DEFAULT_COMPAT_MODE;
    this.runSettingsQuery(
      "UPDATE chat_settings SET compatibility_mode = ?, updated_at = datetime('now')",
      mode,
    );
    logger.info({ mode }, "DB set_global_compatibility_mode");
  }

  setDefaultCompatibilityMode(mode: string): void {
    if (!VALID_COMPAT_MODES.has(mode)) mode = DEFAULT_COMPAT_MODE;
    this.ensureGlobalRow();
    this.runSettingsQuery(
      "UPDATE chat_settings SET compatibility_mode = ?, updated_at = datetime('now') WHERE chat_id = ?",
      mode,
      GLOBAL_CHAT_ID,
    );
    logger.info({ mode }, "DB set_default_compatibility_mode");
  }

  /** Last known device for the chat's audience (used by `auto`), or null. */
  getAutoDevice(chatId: string): string | null {
    const row = this.getSettingRow(chatId);
    return row?.auto_device ?? null;
  }

  /**
   * Persist the detected device for a chat (write-if-changed). Compares against
   * the chat's OWN row (never the __global__ fallback) so a first detection
   * creates the row, and never writes on the global defaults row.
   */
  setAutoDevice(chatId: string, device: string): void {
    if (chatId === GLOBAL_CHAT_ID) return;
    const row = this.getOneFromState<{ auto_device: string | null }>(
      this.settingsState,
      initSettingsTables,
      "SELECT auto_device FROM chat_settings WHERE chat_id = ?",
      chatId,
    );
    const current = row?.auto_device ?? null;
    if (current === device) return; // write-if-changed
    this.ensureChatRow(chatId);
    this.runSettingsQuery(
      "UPDATE chat_settings SET auto_device = ?, updated_at = datetime('now') WHERE chat_id = ?",
      device,
      chatId,
    );
    logger.info({ chatId, device }, "DB set_auto_device");
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

  getLlmProviderConfig(): LlmProviderConfig | null {
    const row = this.getOneFromState<{
      llm1_model: string | null;
      llm1_endpoint: string | null;
      llm1_api_key: string | null;
      llm1_fallback_model: string | null;
      llm1_fallback_endpoint: string | null;
      llm1_fallback_api_key: string | null;
      llm2_model: string | null;
      llm2_endpoint: string | null;
      llm2_api_key: string | null;
      llm2_fallback_model: string | null;
      llm2_fallback_endpoint: string | null;
      llm2_fallback_api_key: string | null;
    }>(
      this.settingsState,
      initSettingsTables,
      `SELECT llm1_model, llm1_endpoint, llm1_api_key,
              llm1_fallback_model, llm1_fallback_endpoint, llm1_fallback_api_key,
              llm2_model, llm2_endpoint, llm2_api_key,
              llm2_fallback_model, llm2_fallback_endpoint, llm2_fallback_api_key
       FROM llm_provider_config WHERE id = 1`,
    );
    if (!row) return null;
    return {
      llm1Model: row.llm1_model,
      llm1Endpoint: row.llm1_endpoint,
      llm1ApiKey: row.llm1_api_key,
      llm1FallbackModel: row.llm1_fallback_model,
      llm1FallbackEndpoint: row.llm1_fallback_endpoint,
      llm1FallbackApiKey: row.llm1_fallback_api_key,
      llm2Model: row.llm2_model,
      llm2Endpoint: row.llm2_endpoint,
      llm2ApiKey: row.llm2_api_key,
      llm2FallbackModel: row.llm2_fallback_model,
      llm2FallbackEndpoint: row.llm2_fallback_endpoint,
      llm2FallbackApiKey: row.llm2_fallback_api_key,
    };
  }

  setLlmProviderConfig(patch: Partial<LlmProviderConfig>): void {
    const current = this.getLlmProviderConfig();
    const next: LlmProviderConfig = {
      llm1Model: patch.llm1Model !== undefined ? patch.llm1Model : current?.llm1Model ?? null,
      llm1Endpoint: patch.llm1Endpoint !== undefined ? patch.llm1Endpoint : current?.llm1Endpoint ?? null,
      llm1ApiKey: patch.llm1ApiKey !== undefined ? patch.llm1ApiKey : current?.llm1ApiKey ?? null,
      llm1FallbackModel: patch.llm1FallbackModel !== undefined ? patch.llm1FallbackModel : current?.llm1FallbackModel ?? null,
      llm1FallbackEndpoint: patch.llm1FallbackEndpoint !== undefined ? patch.llm1FallbackEndpoint : current?.llm1FallbackEndpoint ?? null,
      llm1FallbackApiKey: patch.llm1FallbackApiKey !== undefined ? patch.llm1FallbackApiKey : current?.llm1FallbackApiKey ?? null,
      llm2Model: patch.llm2Model !== undefined ? patch.llm2Model : current?.llm2Model ?? null,
      llm2Endpoint: patch.llm2Endpoint !== undefined ? patch.llm2Endpoint : current?.llm2Endpoint ?? null,
      llm2ApiKey: patch.llm2ApiKey !== undefined ? patch.llm2ApiKey : current?.llm2ApiKey ?? null,
      llm2FallbackModel: patch.llm2FallbackModel !== undefined ? patch.llm2FallbackModel : current?.llm2FallbackModel ?? null,
      llm2FallbackEndpoint: patch.llm2FallbackEndpoint !== undefined ? patch.llm2FallbackEndpoint : current?.llm2FallbackEndpoint ?? null,
      llm2FallbackApiKey: patch.llm2FallbackApiKey !== undefined ? patch.llm2FallbackApiKey : current?.llm2FallbackApiKey ?? null,
    };
    this.runSettingsQuery(
      `INSERT INTO llm_provider_config (
         id, llm1_model, llm1_endpoint, llm1_api_key,
         llm1_fallback_model, llm1_fallback_endpoint, llm1_fallback_api_key,
         llm2_model, llm2_endpoint, llm2_api_key,
         llm2_fallback_model, llm2_fallback_endpoint, llm2_fallback_api_key,
         updated_at
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         llm1_model = excluded.llm1_model,
         llm1_endpoint = excluded.llm1_endpoint,
         llm1_api_key = excluded.llm1_api_key,
         llm1_fallback_model = excluded.llm1_fallback_model,
         llm1_fallback_endpoint = excluded.llm1_fallback_endpoint,
         llm1_fallback_api_key = excluded.llm1_fallback_api_key,
         llm2_model = excluded.llm2_model,
         llm2_endpoint = excluded.llm2_endpoint,
         llm2_api_key = excluded.llm2_api_key,
         llm2_fallback_model = excluded.llm2_fallback_model,
         llm2_fallback_endpoint = excluded.llm2_fallback_endpoint,
         llm2_fallback_api_key = excluded.llm2_fallback_api_key,
         updated_at = excluded.updated_at`,
      next.llm1Model,
      next.llm1Endpoint,
      next.llm1ApiKey,
      next.llm1FallbackModel,
      next.llm1FallbackEndpoint,
      next.llm1FallbackApiKey,
      next.llm2Model,
      next.llm2Endpoint,
      next.llm2ApiKey,
      next.llm2FallbackModel,
      next.llm2FallbackEndpoint,
      next.llm2FallbackApiKey,
    );
    logger.info("DB set_llm_provider_config");
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

  listBotConfig(): BotConfigInfo[] {
    return this.getAllFromState<{
      key: string;
      value: string | null;
      updated_at: string;
    }>(
      this.settingsState,
      initSettingsTables,
      "SELECT key, value, updated_at FROM bot_config ORDER BY key ASC",
    ).map((row) => ({
      key: row.key,
      value: row.value,
      updatedAt: row.updated_at,
    }));
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
    const [text] = this.deleteMemoriesByIndices(scopeKey, [index]);
    return text ?? null;
  }

  /**
   * Delete entries at 1-based indices (oldest-first) within a scope. All
   * indices resolve against a SINGLE snapshot taken before any delete, so
   * deleting [1,2,3] removes the originally-numbered entries — not whatever
   * shifts up after the first delete. Returns the deleted entries' texts in
   * the order the indices were given (out-of-range indices are skipped).
   */
  deleteMemoriesByIndices(scopeKey: string, indices: number[]): string[] {
    const snapshot = this.listMemories(scopeKey);
    const seen = new Set<number>();
    const deleted: string[] = [];
    for (const index of indices) {
      if (!Number.isInteger(index) || index < 1 || index > snapshot.length) continue;
      const row = snapshot[index - 1];
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      this.runSettingsQuery("DELETE FROM memories WHERE id = ?", row.id);
      deleted.push(row.text);
    }
    if (deleted.length) logger.info({ scopeKey, indices }, "DB delete_memory");
    return deleted;
  }

  // -------------------------------------------------------------------------
  // Persisted chat directory. The gateway learns these labels from normal
  // traffic / metadata it already needed, so the control panel can render
  // friendly scope names without issuing a risky live group-metadata sweep.
  // -------------------------------------------------------------------------

  upsertChatDirectory(
    chatId: string,
    displayName: string,
    chatType: "group" | "private",
  ): void {
    const normalizedId = chatId.trim();
    const normalizedName = displayName.trim().slice(0, 160);
    if (!normalizedId || !normalizedName || normalizedName === normalizedId) return;
    this.runSettingsQuery(
      `INSERT INTO chat_directory (chat_id, display_name, chat_type, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(chat_id) DO UPDATE SET
         display_name = excluded.display_name,
         chat_type = excluded.chat_type,
         updated_at = excluded.updated_at
       WHERE chat_directory.display_name <> excluded.display_name
          OR chat_directory.chat_type <> excluded.chat_type`,
      normalizedId,
      normalizedName,
      chatType,
    );
  }

  getChatDirectoryEntry(chatId: string): ChatDirectoryInfo | null {
    if (!chatId || chatId === GLOBAL_CHAT_ID) return null;
    const row = this.getOneFromState<{
      chat_id: string;
      display_name: string;
      chat_type: "group" | "private";
      updated_at: string;
    }>(
      this.settingsState,
      initSettingsTables,
      `SELECT chat_id, display_name, chat_type, updated_at
       FROM chat_directory WHERE chat_id = ?`,
      chatId,
    );
    return row
      ? {
          chatId: row.chat_id,
          displayName: row.display_name,
          chatType: row.chat_type,
          updatedAt: row.updated_at,
        }
      : null;
  }

  listChatDirectory(): ChatDirectoryInfo[] {
    return this.getAllFromState<{
      chat_id: string;
      display_name: string;
      chat_type: "group" | "private";
      updated_at: string;
    }>(
      this.settingsState,
      initSettingsTables,
      `SELECT chat_id, display_name, chat_type, updated_at
       FROM chat_directory
       ORDER BY display_name COLLATE NOCASE ASC, chat_id ASC`,
    ).map((row) => ({
      chatId: row.chat_id,
      displayName: row.display_name,
      chatType: row.chat_type,
      updatedAt: row.updated_at,
    }));
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

