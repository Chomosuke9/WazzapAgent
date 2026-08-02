// LLM model config domain: per-chat model (chat_settings.llm2_model) + the
// default/global model catalog (llm_models). Methods + SQL are VERBATIM from
// the old src/db.ts; per-domain module state became BaseRepository helpers.

import logger from "../../logger.js";
import { initSettingsTables } from "../schema/index.js";
import { BaseRepository } from "./BaseRepository.js";

interface LlmModelRow {
  model_id: string;
  display_name: string;
  description: string | null;
  is_active: number;
  is_default: number;
  sort_order: number;
  vision_support: number;
}

interface DefaultLlm2Model {
  modelId: string;
  displayName: string;
  description: string | null;
  visionSupport: boolean;
}

interface ActiveModelInfo {
  modelId: string;
  displayName: string;
  description: string | null;
  isDefault: boolean;
  sortOrder: number;
  visionSupport: boolean;
}

interface ModelInfo {
  modelId: string;
  displayName: string;
  description: string | null;
  isActive: boolean;
  isDefault: boolean;
  sortOrder: number;
  visionSupport: boolean;
}

interface UpdateModelOptions {
  displayName?: string;
  description?: string;
  isActive?: boolean;
  sortOrder?: number;
  visionSupport?: boolean;
}

interface DeleteModelResult {
  success: boolean;
  affectedChatIds: string[];
}

export class ModelRepository extends BaseRepository {
  private normalizeDefaultModel(): void {
    const models = this.getAllFromState<
      Pick<LlmModelRow, "model_id" | "is_active" | "is_default" | "sort_order">
    >(
      this.settingsState,
      initSettingsTables,
      `SELECT model_id, is_active, is_default, sort_order
       FROM llm_models
       ORDER BY sort_order ASC, model_id COLLATE NOCASE ASC`,
    );
    const selected = models.find(
      (model) => model.is_default === 1 && model.is_active === 1,
    ) || models.find((model) => model.is_active === 1);
    if (selected) {
      this.runSettingsQuery(
        "UPDATE llm_models SET is_default = CASE WHEN model_id = ? THEN 1 ELSE 0 END",
        selected.model_id,
      );
    } else if (models.length) {
      this.runSettingsQuery("UPDATE llm_models SET is_default = 0");
    }
  }

  getDefaultLlm2Model(): DefaultLlm2Model | null {
    const row = this.getOneFromState<
      Pick<
        LlmModelRow,
        "model_id" | "display_name" | "description" | "vision_support"
      >
    >(
      this.settingsState,
      initSettingsTables,
      "SELECT model_id, display_name, description, vision_support FROM llm_models WHERE is_active = 1 AND is_default = 1 LIMIT 1",
    );
    if (row)
      return {
        modelId: row.model_id,
        displayName: row.display_name,
        description: row.description,
        visionSupport: Boolean(row.vision_support),
      };
    return null;
  }

  getLlm2Model(chatId: string): string | null {
    const row = this.getSettingRow(chatId);
    return row?.llm2_model ?? null;
  }

  setLlm2Model(chatId: string, modelId: string | null): void {
    this.ensureChatRow(chatId);
    this.runSettingsQuery(
      "UPDATE chat_settings SET llm2_model = ?, updated_at = datetime('now') WHERE chat_id = ?",
      modelId,
      chatId,
    );
    logger.info({ chatId, modelId }, "DB set_llm2_model");
  }

  getAllActiveModels(): ActiveModelInfo[] {
    const rows = this.getAllFromState<
      Pick<
        LlmModelRow,
        "model_id" | "display_name" | "description" | "is_default" | "sort_order" | "vision_support"
      >
    >(
      this.settingsState,
      initSettingsTables,
      "SELECT model_id, display_name, description, is_default, sort_order, vision_support FROM llm_models WHERE is_active = 1 ORDER BY sort_order ASC, model_id COLLATE NOCASE ASC",
    );
    return rows.map((row) => ({
      modelId: row.model_id,
      displayName: row.display_name,
      description: row.description,
      isDefault: Boolean(row.is_default),
      sortOrder: row.sort_order,
      visionSupport: Boolean(row.vision_support),
    }));
  }

  getAllModels(): ModelInfo[] {
    const rows = this.getAllFromState<LlmModelRow>(
      this.settingsState,
      initSettingsTables,
      "SELECT model_id, display_name, description, is_active, is_default, sort_order, vision_support FROM llm_models ORDER BY sort_order ASC, model_id COLLATE NOCASE ASC",
    );
    return rows.map((row) => ({
      modelId: row.model_id,
      displayName: row.display_name,
      description: row.description,
      isActive: Boolean(row.is_active),
      isDefault: Boolean(row.is_default),
      sortOrder: row.sort_order,
      visionSupport: Boolean(row.vision_support),
    }));
  }

  addModel(
    modelId: string,
    displayName: string,
    description: string = "",
    sortOrder: number | null = null,
    visionSupport: boolean = false,
  ): boolean {
    if (sortOrder === null) {
      const maxOrder = this.getOneFromState<{ max_order: number | null }>(
        this.settingsState,
        initSettingsTables,
        "SELECT MAX(sort_order) as max_order FROM llm_models",
      );
      sortOrder = (maxOrder?.max_order ?? -1) + 1;
    } else {
      sortOrder = Math.max(0, sortOrder);
    }
    try {
      this.runSettingsQuery(
        "INSERT INTO llm_models (model_id, display_name, description, sort_order, vision_support) VALUES (?, ?, ?, ?, ?)",
        modelId,
        displayName,
        description,
        sortOrder,
        visionSupport ? 1 : 0,
      );
      this.normalizeDefaultModel();
      logger.info({ modelId, displayName, visionSupport }, "DB add_model");
      return true;
    } catch (err: unknown) {
      if (
        (err as { message?: string; code?: string } | null)?.message?.includes("UNIQUE constraint failed") ||
        (err as { code?: string } | null)?.code === "SQLITE_CONSTRAINT_PRIMARYKEY"
      )
        return false;
      throw err;
    }
  }

  updateModel(
    modelId: string,
    { displayName, description, isActive, sortOrder, visionSupport }: UpdateModelOptions = {},
  ): boolean {
    const existing = this.getOneFromState<Pick<LlmModelRow, "model_id">>(
      this.settingsState,
      initSettingsTables,
      "SELECT model_id FROM llm_models WHERE model_id = ?",
      modelId,
    );
    if (!existing) return false;
    const updates: string[] = [];
    const values: unknown[] = [];
    if (displayName !== undefined) {
      updates.push("display_name = ?");
      values.push(displayName);
    }
    if (description !== undefined) {
      updates.push("description = ?");
      values.push(description);
    }
    if (isActive !== undefined) {
      updates.push("is_active = ?");
      values.push(isActive ? 1 : 0);
    }
    if (sortOrder !== undefined) {
      updates.push("sort_order = ?");
      values.push(Math.max(0, sortOrder));
    }
    if (visionSupport !== undefined) {
      updates.push("vision_support = ?");
      values.push(visionSupport ? 1 : 0);
    }
    if (updates.length === 0) return true;
    values.push(modelId);
    this.runSettingsQuery(
      `UPDATE llm_models SET ${updates.join(", ")} WHERE model_id = ?`,
      ...values,
    );
    this.normalizeDefaultModel();
    logger.info({ modelId }, "DB update_model");
    return true;
  }

  /** Select the tenant default without changing the catalog's visual order. */
  setDefaultModel(modelId: string): boolean {
    const existing = this.getOneFromState<Pick<LlmModelRow, "model_id">>(
      this.settingsState,
      initSettingsTables,
      "SELECT model_id FROM llm_models WHERE model_id = ?",
      modelId,
    );
    if (!existing) return false;
    this.runSettingsQuery(
      `UPDATE llm_models
       SET is_default = CASE WHEN model_id = ? THEN 1 ELSE 0 END,
           is_active = CASE WHEN model_id = ? THEN 1 ELSE is_active END`,
      modelId,
      modelId,
    );
    logger.info({ modelId }, "DB set_default_model");
    return true;
  }

  deleteModel(modelId: string): DeleteModelResult {
    const existing = this.getOneFromState<Pick<LlmModelRow, "model_id">>(
      this.settingsState,
      initSettingsTables,
      "SELECT model_id FROM llm_models WHERE model_id = ?",
      modelId,
    );
    if (!existing) return { success: false, affectedChatIds: [] };
    const affectedRows = this.getAllFromState<{ chat_id: string }>(
      this.settingsState,
      initSettingsTables,
      "SELECT chat_id FROM chat_settings WHERE llm2_model = ?",
      modelId,
    );
    const affectedChatIds = affectedRows.map((r) => r.chat_id);
    this.runSettingsQuery("DELETE FROM llm_models WHERE model_id = ?", modelId);
    this.runSettingsQuery(
      "UPDATE chat_settings SET llm2_model = NULL WHERE llm2_model = ?",
      modelId,
    );
    this.normalizeDefaultModel();
    logger.info({ modelId, affectedChatIds }, "DB delete_model");
    return { success: true, affectedChatIds };
  }

  setGlobalLlm2Model(modelId: string | null): void {
    this.runSettingsQuery(
      "UPDATE chat_settings SET llm2_model = ?, updated_at = datetime('now')",
      modelId,
    );
    logger.info({ modelId }, "DB set_global_llm2_model");
  }
}
