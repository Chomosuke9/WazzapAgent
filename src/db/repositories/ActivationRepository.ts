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

interface RevokedCode {
  id: number;
  code: string;
  wasUsed: boolean;
  usedBy: string | null;
}

interface BatchRevokeResult {
  revoked: RevokedCode[];
  notFound: number[];
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
      return { success: false, message: "Activation code not found." };
    }
    const codeRow = codeRows[0];
    if (codeRow.used) {
      return { success: false, message: "Activation code already used." };
    }
    const codeType = codeRow.type;
    if (codeType !== "all") {
      const expected = chatType === "group" ? "group" : "private";
      if (codeType !== expected) {
        return { success: false, message: `This code is only for ${codeType === "group" ? "groups" : "private chats"}.` };
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
    const now = new Date();
    const existingExpiry =
      existingRows.length > 0 ? existingRows[0].expires_at : undefined;
    // A pre-existing row with a NULL expires_at means the chat is already
    // permanently active. A limited (days > 0) code must NEVER downgrade a
    // permanent activation to a finite expiry — applying a shorter code on top
    // of an unlimited one should keep it unlimited.
    const existingIsPermanent =
      existingRows.length > 0 &&
      (existingExpiry === null || existingExpiry === undefined);

    let expiresAt: string | null = null;
    if (daysInt > 0 && !existingIsPermanent) {
      if (existingExpiry) {
        // Extend from the later of the current (future) expiry or now, so a
        // re-activation never shortens an in-effect activation.
        const currentExpiry = new Date(existingExpiry);
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
      // Either the new code is permanent (days === 0) or the chat is already
      // permanently active — in both cases the result is a permanent activation.
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
    if (expiresAt === null) {
      return { success: true, message: "Activation successful! This chat is now permanently active.", expiresAt: null };
    }
    return { success: true, message: `Activation successful! This chat is active for ${daysInt} days.`, expiresAt };
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
    const { revoked, notFound } = this.revokeActivationCodes([id]);
    if (notFound.length > 0 || revoked.length === 0) {
      return { success: false, message: "Activation code not found." };
    }
    const r = revoked[0];
    return {
      success: true,
      message: "Activation code revoked.",
      wasUsed: r.wasUsed,
      usedBy: r.usedBy,
    };
  }

  /**
   * Revoke several activation codes at once (e.g. `/revoke 1,2,3`). Each id is
   * deleted; a used code additionally drops its `chat_activations` row so the
   * chat loses access (same cascade as the single-id path). Ids with no
   * matching row are returned in `notFound` rather than aborting the batch.
   */
  revokeActivationCodes(ids: number[]): BatchRevokeResult {
    this.ensureSettingsDbReady();
    const revoked: RevokedCode[] = [];
    const notFound: number[] = [];
    for (const id of ids) {
      const rows = queryRows<
        Pick<ActivationCodeRow, "id" | "code" | "used" | "used_by">
      >(
        this.settingsState.db!,
        "SELECT id, code, used, used_by FROM activation_codes WHERE id = ?",
        id,
      );
      if (rows.length === 0) {
        notFound.push(id);
        continue;
      }
      const codeRow = rows[0];
      const wasUsed = codeRow.used === 1;
      this.runSettingsQuery("DELETE FROM activation_codes WHERE id = ?", id);
      if (wasUsed) {
        this.runSettingsQuery(
          "DELETE FROM chat_activations WHERE code = ?",
          codeRow.code,
        );
      }
      revoked.push({ id, code: codeRow.code, wasUsed, usedBy: codeRow.used_by });
    }
    logger.info(
      { revoked: revoked.map((r) => r.id), notFound },
      "DB revoke_activation_codes",
    );
    return { revoked, notFound };
  }

  /**
   * Revoke every activation code that has not yet been used (`used = 0`). Used
   * codes are left untouched so no activated chat loses access. Returns the
   * same {@link BatchRevokeResult} shape (`notFound` is always empty here).
   */
  revokeUnusedActivationCodes(): BatchRevokeResult {
    this.ensureSettingsDbReady();
    const unusedIds = queryRows<Pick<ActivationCodeRow, "id">>(
      this.settingsState.db!,
      "SELECT id FROM activation_codes WHERE used = 0 ORDER BY id ASC",
    ).map((r) => r.id);
    return this.revokeActivationCodes(unusedIds);
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
