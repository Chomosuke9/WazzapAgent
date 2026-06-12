// Activation domain: activation code generation/lookup/revocation and per-chat
// activation state (activation_codes + chat_activations tables in settings.db).
// Methods + SQL are VERBATIM from the old src/db.ts; per-domain module state became
// BaseRepository helpers / `this.db.settingsState`.

import logger from "../../logger.js";
import { queryRows } from "../schema/index.js";
import { BaseRepository } from "./BaseRepository.js";

interface ActivationCodeRow {
  id: number;
  code: string;
  type: string;
  days: number;
  used: number;
  used_by: string | null;
  created_at: string;
  created_by: string;
}

interface ChatActivationRow {
  chat_id: string;
  code: string;
  activated_at: string;
  expires_at: string | null;
  expiry_notified: number;
}

interface GeneratedActivationCode {
  id: number;
  code: string;
  type: string;
  days: number;
  createdAt: string;
  createdBy: string;
}

interface ActivateChatResult {
  success: boolean;
  message: string;
  expiresAt?: string | null;
}

interface ActivationCodeInfo {
  id: number;
  code: string;
  type: string;
  days: number;
  used: boolean;
  usedBy: string | null;
  createdAt: string;
  createdBy: string;
}

interface ChatActivationInfo {
  chatId: string;
  code: string;
  activatedAt: string;
  expiresAt: string | null;
  expiryNotified: boolean;
}

interface RevokeActivationCodeResult {
  success: boolean;
  message: string;
  wasUsed?: boolean;
  usedBy?: string | null;
}

export class ActivationRepository extends BaseRepository {
  generateActivationCode(
    type: string,
    days: number,
    createdBy: string,
  ): GeneratedActivationCode {
    const validTypes = new Set(["private", "group", "all"]);
    if (!validTypes.has(type)) {
      throw new Error(`Invalid activation type: ${type}`);
    }
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "WA-";
    for (let i = 0; i < 8; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    const daysInt = Math.max(0, Math.floor(days));
    this.ensureSettingsDbReady();
    this.settingsState.db!.run(
      `INSERT INTO activation_codes (code, type, days, created_by) VALUES (?, ?, ?, ?)`,
      [code, type, daysInt, createdBy],
    );
    const row = queryRows<
      Pick<
        ActivationCodeRow,
        "id" | "code" | "type" | "days" | "created_at" | "created_by"
      >
    >(
      this.settingsState.db!,
      "SELECT id, code, type, days, created_at, created_by FROM activation_codes WHERE code = ?",
      code,
    );
    if (row.length === 0) {
      throw new Error("Failed to retrieve generated activation code");
    }
    logger.info({ id: row[0].id, code, type, days: daysInt, createdBy }, "DB generate_activation_code");
    return {
      id: row[0].id,
      code: row[0].code,
      type: row[0].type,
      days: row[0].days,
      createdAt: row[0].created_at,
      createdBy: row[0].created_by,
    };
  }

  activateChat(
    chatId: string,
    code: string,
    chatType: string,
  ): ActivateChatResult {
    this.ensureSettingsDbReady();
    const codeRows = queryRows<ActivationCodeRow>(
      this.settingsState.db!,
      "SELECT id, code, type, days, used, used_by, created_at, created_by FROM activation_codes WHERE code = ?",
      code.toUpperCase(),
    );
    if (codeRows.length === 0) {
      return { success: false, message: "Kode aktivasi tidak ditemukan." };
    }
    const codeRow = codeRows[0];
    if (codeRow.used) {
      return { success: false, message: "Kode aktivasi sudah digunakan." };
    }
    const codeType = codeRow.type;
    if (codeType !== "all") {
      const expected = chatType === "group" ? "group" : "private";
      if (codeType !== expected) {
        return { success: false, message: `Kode ini hanya untuk ${codeType === "group" ? "grup" : "chat privat"}.` };
      }
    }
    this.runSettingsQuery(
      "UPDATE activation_codes SET used = 1, used_by = ? WHERE code = ?",
      chatId,
      code.toUpperCase(),
    );
    const existingRows = queryRows<
      Pick<ChatActivationRow, "chat_id" | "code" | "activated_at" | "expires_at">
    >(
      this.settingsState.db!,
      "SELECT chat_id, code, activated_at, expires_at FROM chat_activations WHERE chat_id = ?",
      chatId,
    );
    const daysInt = codeRow.days;
    let expiresAt: string | null = null;
    const now = new Date();
    if (daysInt > 0) {
      if (existingRows.length > 0 && existingRows[0].expires_at) {
        const currentExpiry = new Date(existingRows[0].expires_at);
        const baseDate = currentExpiry > now ? currentExpiry : now;
        expiresAt = new Date(baseDate.getTime() + daysInt * 86400000)
          .toISOString()
          .replace("T", " ")
          .slice(0, 19);
      } else {
        expiresAt = new Date(now.getTime() + daysInt * 86400000)
          .toISOString()
          .replace("T", " ")
          .slice(0, 19);
      }
    } else {
      expiresAt = null;
    }

    if (existingRows.length > 0) {
      this.runSettingsQuery(
        "UPDATE chat_activations SET code = ?, activated_at = datetime('now'), expires_at = ?, expiry_notified = 0 WHERE chat_id = ?",
        code.toUpperCase(),
        expiresAt,
        chatId,
      );
    } else {
      this.runSettingsQuery(
        "INSERT INTO chat_activations (chat_id, code, activated_at, expires_at) VALUES (?, ?, datetime('now'), ?)",
        chatId,
        code.toUpperCase(),
        expiresAt,
      );
    }
    logger.info({ chatId, code: code.toUpperCase(), days: daysInt, expiresAt }, "DB activate_chat");
    if (daysInt === 0) {
      return { success: true, message: "Aktivasi berhasil! Chat ini sekarang aktif secara permanen.", expiresAt: null };
    }
    return { success: true, message: `Aktivasi berhasil! Chat ini aktif selama ${daysInt} hari.`, expiresAt };
  }

  isChatActivated(chatId: string): boolean {
    this.ensureSettingsDbReady();
    const rows = queryRows<Pick<ChatActivationRow, "chat_id" | "expires_at">>(
      this.settingsState.db!,
      "SELECT chat_id, expires_at FROM chat_activations WHERE chat_id = ?",
      chatId,
    );
    if (rows.length === 0) return false;
    const expiresAt = rows[0].expires_at;
    if (expiresAt === null || expiresAt === undefined) return true;
    return new Date(expiresAt) > new Date();
  }

  getChatActivation(chatId: string): ChatActivationInfo | null {
    this.ensureSettingsDbReady();
    const rows = queryRows<ChatActivationRow>(
      this.settingsState.db!,
      "SELECT chat_id, code, activated_at, expires_at, expiry_notified FROM chat_activations WHERE chat_id = ?",
      chatId,
    );
    if (rows.length === 0) return null;
    return {
      chatId: rows[0].chat_id,
      code: rows[0].code,
      activatedAt: rows[0].activated_at,
      expiresAt: rows[0].expires_at,
      expiryNotified: rows[0].expiry_notified === 1,
    };
  }

  getAllActivationCodes(): ActivationCodeInfo[] {
    this.ensureSettingsDbReady();
    return queryRows<ActivationCodeRow>(
      this.settingsState.db!,
      "SELECT id, code, type, days, used, used_by, created_at, created_by FROM activation_codes ORDER BY id ASC",
    ).map((row) => ({
      id: row.id,
      code: row.code,
      type: row.type,
      days: row.days,
      used: row.used === 1,
      usedBy: row.used_by,
      createdAt: row.created_at,
      createdBy: row.created_by,
    }));
  }

  getAllActivations(): ChatActivationInfo[] {
    this.ensureSettingsDbReady();
    return queryRows<ChatActivationRow>(
      this.settingsState.db!,
      "SELECT chat_id, code, activated_at, expires_at, expiry_notified FROM chat_activations ORDER BY activated_at ASC",
    ).map((row) => ({
      chatId: row.chat_id,
      code: row.code,
      activatedAt: row.activated_at,
      expiresAt: row.expires_at,
      expiryNotified: row.expiry_notified === 1,
    }));
  }

  revokeActivationCode(id: number): RevokeActivationCodeResult {
    this.ensureSettingsDbReady();
    const rows = queryRows<Pick<ActivationCodeRow, "id" | "code" | "used" | "used_by">>(
      this.settingsState.db!,
      "SELECT id, code, used, used_by FROM activation_codes WHERE id = ?",
      id,
    );
    if (rows.length === 0) {
      return { success: false, message: "Kode aktivasi tidak ditemukan." };
    }
    const codeRow = rows[0];
    const wasUsed = codeRow.used === 1;
    const usedBy = codeRow.used_by;
    this.runSettingsQuery("DELETE FROM activation_codes WHERE id = ?", id);
    if (wasUsed) {
      this.runSettingsQuery("DELETE FROM chat_activations WHERE code = ?", codeRow.code);
    }
    logger.info({ id, code: codeRow.code, wasUsed, usedBy }, "DB revoke_activation_code");
    return { success: true, message: "Kode aktivasi dicabut.", wasUsed, usedBy };
  }

  markExpiryNotified(chatId: string): void {
    this.ensureSettingsDbReady();
    this.runSettingsQuery(
      "UPDATE chat_activations SET expiry_notified = 1 WHERE chat_id = ?",
      chatId,
    );
  }

  isExpiryNotified(chatId: string): boolean {
    this.ensureSettingsDbReady();
    const rows = queryRows<Pick<ChatActivationRow, "expiry_notified">>(
      this.settingsState.db!,
      "SELECT expiry_notified FROM chat_activations WHERE chat_id = ?",
      chatId,
    );
    if (rows.length === 0) return false;
    return rows[0].expiry_notified === 1;
  }
}
