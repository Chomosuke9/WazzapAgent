/**
 * baileysFactory.ts — per-tenant Baileys account factory (Step 17).
 *
 * `createOrResumeAccount(opts)` generalizes the old single-global-`sock`
 * `startWhatsApp` into a per-`folderPath` factory: it ensures the tenant folder
 * layout (CONTRACT.md §8), wires Node's DB layer at `<folderPath>/db/`, builds
 * the account's {@link AccountContext} (Step 16), creates the Baileys socket,
 * binds ALL event listeners to that account's context (no module global), and
 * registers everything in the account registry (Step 15). This is what lets one
 * Node process drive N WhatsApp accounts.
 *
 * Scope guard (per the step spec):
 *   - NO WS server (Step 20), NO action dispatch (Step 19).
 *   - Event forwarding beyond attaching listeners that call into the existing
 *     handlers (inbound/events) is Step 18.
 *
 * The shared, account-parameterized helpers the listeners call into
 * (`handleButtonResponse`, `parseModelReply`, the pending-form accessors, QR
 * print) live in `wa/connection.ts`. The factory imports them statically;
 * `connection.ts` lazy-imports this module from its thin `startWhatsApp()`
 * shim, so there is no static import cycle.
 */
import path from "path";
import fs from "fs-extra";
import makeWASocket, {
  fetchLatestBaileysVersion,
  DisconnectReason,
} from "baileys";
import type { WASocket, WAMessage, AuthenticationState } from "baileys";
import { useCachedAuthState } from "../utils/cachedAuthState.js";
import logger from "../logger.js";
import config from "../config.js";
import { createAccountContext } from "./accountContext.js";
import type { AccountContext } from "./accountContext.js";
import { forwardStatus } from "./eventForwarder.js";
import * as registry from "../server/accountRegistry.js";
import type {
  AccountEntry,
  BaileysFactoryOptions,
  WaStatus,
} from "../protocol/types.js";
import { initWithDbDir } from "../db.js";
import {
  invalidateGroupMetadata,
  getGroupContext,
} from "../groupContext.js";
import { parseSlashCommand } from "../wa/command/index.js";
import { roleFlagsForJid, isOwnerJid } from "../participants.js";
import {
  normalizeJid,
  ensureContextMsgId,
  messageIdIndexKey,
} from "../identifiers.js";
import { unwrapMessage, extractText } from "../messageParser.js";
import { runWithConcurrency } from "../wa/utils.js";
import { GROUP_JOIN_STUB_TYPES } from "../caches.js";
import type { GroupContextValue } from "../caches.js";
import { handleCommandListener } from "../wa/commandHandler.js";
import {
  handleButtonResponse,
  parseModelReply,
  getPendingForm,
  clearPendingForm,
  printQrInTerminal,
} from "../wa/connection.js";

// ---------------------------------------------------------------------------
// Test seam: socket creator
// ---------------------------------------------------------------------------

/** Creates a live Baileys {@link WASocket} from a prepared auth state. */
type SocketCreator = (authState: AuthenticationState) => Promise<WASocket>;

const defaultSocketCreator: SocketCreator = async (authState) => {
  const { version } = await fetchLatestBaileysVersion();
  logger.info({ version }, "starting whatsapp socket");
  return makeWASocket({
    version,
    auth: authState,
    syncFullHistory: false,
    browser: ["WazzapAgents", "Chrome", "1.0"],
    markOnlineOnConnect: false,
    defaultQueryTimeoutMs: config.sendTimeoutMs,
  });
};

let socketCreator: SocketCreator = defaultSocketCreator;

/**
 * TEST SEAM — override the Baileys socket creator so tests run fully offline
 * (no `fetchLatestBaileysVersion` network call, no real socket). Pass `null` to
 * restore the default creator.
 */
export function __setSocketCreatorForTests(fn: SocketCreator | null): void {
  socketCreator = fn ?? defaultSocketCreator;
}

// ---------------------------------------------------------------------------
// Folder layout + status normalization (CONTRACT.md §8 / §5)
// ---------------------------------------------------------------------------

export interface TenantLayout {
  authDir: string;
  dbDir: string;
  mediaDir: string;
  stickersDir: string;
}

/**
 * Ensure the per-tenant folder layout exists (CONTRACT.md §8):
 * `<folderPath>/{auth,db,media,stickers}`. Created by Node before use. Returns
 * the resolved sub-directory paths.
 */
export function ensureFolderLayout(folderPath: string): TenantLayout {
  const authDir = path.join(folderPath, "auth");
  const dbDir = path.join(folderPath, "db");
  const mediaDir = path.join(folderPath, "media");
  const stickersDir = path.join(folderPath, "stickers");
  fs.ensureDirSync(folderPath);
  fs.ensureDirSync(authDir);
  fs.ensureDirSync(dbDir);
  fs.ensureDirSync(mediaDir);
  fs.ensureDirSync(stickersDir);
  return { authDir, dbDir, mediaDir, stickersDir };
}

/**
 * Normalize a Baileys `connection.update` connection value to the CONTRACT.md
 * {@link WaStatus}: `"open"→"open"`, `"close"/"closed"→"close"`,
 * `"connecting"/undefined→"connecting"`.
 */
function normalizeWaStatus(connection: string | undefined | null): WaStatus {
  if (connection === "open") return "open";
  if (connection === "close" || connection === "closed") return "close";
  return "connecting";
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create or resume the WhatsApp account for `opts.folderPath`.
 *
 * Idempotent: if a live socket already exists for the folder, the existing
 * {@link AccountEntry} is returned unchanged.
 */
export async function createOrResumeAccount(
  opts: BaileysFactoryOptions,
): Promise<AccountEntry> {
  const { folderPath } = opts;
  const entry = registry.getOrCreate(folderPath);

  // Idempotent: a live socket already exists for this folder.
  if (entry.sock) {
    logger.debug({ folderPath }, "account already has a live socket; resuming");
    return entry;
  }

  const layout = ensureFolderLayout(folderPath);

  // Per-tenant DB wiring (CONTRACT.md §8). No-op if the global init already ran
  // (legacy single-account boot), so the live boot's DBs are never clobbered.
  await initWithDbDir(layout.dbDir);

  // Build the per-account state holder, reusing any existing context already
  // registered for this folder so object identity stays shared between the
  // message path and the action dispatcher.
  const existingCtx = entry.ctx as AccountContext;
  if (!existingCtx || !existingCtx.messageCache) {
    entry.ctx = createAccountContext(folderPath);
  }

  await buildSocket(entry, layout.authDir, opts);
  return entry;
}

/**
 * Create the Baileys socket for `entry` and attach all listeners bound to the
 * account's context. This is also the reconnect unit: on a non-logged-out
 * close it clears `entry.sock` and rebuilds, preserving the folder/DB/context
 * setup done once in {@link createOrResumeAccount}.
 */
async function buildSocket(
  entry: AccountEntry,
  authDir: string,
  opts: BaileysFactoryOptions,
): Promise<void> {
  const account = entry.ctx as AccountContext;
  const folderPath = entry.folderPath;
  const printQr = opts.printQr !== false;

  // Lazy imports mirror the original startWhatsApp to avoid circular-dependency
  // init-order issues (inbound/events were historically wired through connection.ts).
  const { handleIncomingMessage, handleGroupParticipantsUpdate } = await import(
    "../wa/inbound.js"
  );
  const { emitGroupJoinContextEvent } = await import("../wa/events.js");
  const { parseGroupJoinStub } = await import("../groupContext.js");

  const { state, saveCreds } = await useCachedAuthState(authDir);

  const sock = await socketCreator(state as unknown as AuthenticationState);
  registry.bindSock(folderPath, sock);
  // Thread the live socket onto the per-account context so every ctx-first
  // `wa/*` helper, `groupContext`, and command handler reaches THIS account's
  // socket via `ctx.sock` (Step 33 — replaces the removed global socket accessor).
  // Refreshed here on every (re)build so reconnects rebind the new socket.
  account.sock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && printQr) {
      logger.info("Scan QR to authenticate (valid for 20 seconds)");
      printQrInTerminal(qr);
    }
    if (!connection) return;

    const status = normalizeWaStatus(connection);
    entry.waStatus = status;

    if (status === "close") {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const reason = lastDisconnect?.error;
      logger.warn({ statusCode, reason, folderPath }, "connection closed");
      // Step 18: forward the normalized `whatsapp_status` exactly once via the
      // forwarder (the registry routes it to the account's bound client, or
      // queues it when none is bound). `onStatusChange` stays a side-hook only.
      forwardStatus(entry, status, statusCode);
      try {
        opts.onStatusChange?.(status, statusCode);
      } catch (err) {
        logger.error({ err }, "onStatusChange handler failed");
      }
      if (statusCode !== DisconnectReason.loggedOut) {
        // Rebuild only the socket; folder/DB/context setup is preserved.
        entry.sock = undefined;
        buildSocket(entry, authDir, opts).catch((err) =>
          logger.error({ err, folderPath }, "reconnect failed"),
        );
      } else {
        logger.error(
          "Logged out from WhatsApp. Delete auth folder to re-pair.",
        );
      }
      return;
    }

    if (status === "open") {
      logger.info({ folderPath }, "WhatsApp socket connected");
      // Step 18: forward the normalized `whatsapp_status` exactly once.
      forwardStatus(entry, status);
    }
    try {
      opts.onStatusChange?.(status);
    } catch (err) {
      logger.error({ err }, "onStatusChange handler failed");
    }
  });

  sock.ev.on("groups.update", (updates) => {
    if (!Array.isArray(updates)) return;
    for (const update of updates) {
      const jid = update?.id;
      if (!jid) continue;
      invalidateGroupMetadata(account, jid);
    }
  });

  sock.ev.on("group-participants.update", async (update) => {
    try {
      await handleGroupParticipantsUpdate(account, update);
    } catch (err) {
      logger.error(
        { err, update },
        "failed handling group participants update",
      );
    }
  });

  // Listener 1: command handler (non-blocking, instant response)
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    logger.debug(
      { type, messageCount: messages?.length },
      "messages.upsert received",
    );

    if (!Array.isArray(messages) || messages.length === 0) return;

    for (const msg of messages) {
      try {
        const chatId = msg?.key?.remoteJid;
        if (!chatId || chatId === "status@broadcast") continue;
        if (!msg?.message) continue;
        // Bot messages are forwarded as contextOnly=true in inbound.ts; the
        // Python bridge won't trigger LLM1 on them, preventing response loops.

        const fromId = msg.key.participant || msg.key.remoteJid;
        const senderId = (normalizeJid(fromId) || fromId) as string;

        logger.info(
          {
            chatId,
            senderId,
            msgKey: msg?.key?.id,
            type,
            msgContentType: msg.message
              ? Object.keys(msg.message).join(",")
              : "none",
          },
          "message received",
        );

        if (await handleButtonResponse(sock, account, msg, chatId, senderId)) {
          continue;
        }

        const { message: innerMessage } = unwrapMessage(msg.message);
        const text = extractText(innerMessage);

        const pending = getPendingForm(account, chatId);
        if (pending && senderId === pending.senderId) {
          const normalizedText = text?.trim().toLowerCase();
          if (normalizedText === "cancel" || normalizedText === "batal") {
            clearPendingForm(account, chatId);
            await sock.sendMessage(chatId, { text: "Operasi dibatalkan." });
            continue;
          }

          const result = parseModelReply(account, chatId, text as string);
          if (result) {
            if (result.action === "edit_model") {
              if (result.success) {
                registry.sendReliableToClient(folderPath, {
                  type: "invalidate_default_model",
                  folderPath,
                });
              }
              await sock.sendMessage(chatId, {
                text: result.success
                  ? `Model "${result.modelId}" diupdate.`
                  : `Model "${result.modelId}" tidak ditemukan.`,
              });
            } else if (result.action === "add_model") {
              if (result.error) {
                await sock.sendMessage(chatId, { text: result.error });
              } else {
                const { addModel } = await import("../db.js");
                const success = addModel(
                  result.modelId!,
                  result.displayName!,
                  result.description,
                  null,
                  result.visionSupport,
                );
                if (success) {
                  registry.sendReliableToClient(folderPath, {
                    type: "invalidate_default_model",
                    folderPath,
                  });
                }
                await sock.sendMessage(chatId, {
                  text: success
                    ? `Model "${result.displayName}" ditambahkan.${result.visionSupport ? " (Vision enabled)" : ""}`
                    : `Model "${result.modelId}" sudah ada.`,
                });
              }
            }
            continue;
          }
        }
        if (!text || typeof text !== "string") continue;

        const slashCommand = parseSlashCommand(text);
        if (!slashCommand) continue;

        const isGroup = chatId.endsWith("@g.us");
        const chatType = isGroup ? "group" : "private";

        let senderIsAdmin = false;
        let botIsAdmin = false;
        let botIsSuperAdmin = false;
        let group: GroupContextValue | null = null;

        if (isGroup) {
          group = await getGroupContext(account, chatId);
          const senderRole = roleFlagsForJid(group?.participantRoles, senderId);
          senderIsAdmin = senderRole.isAdmin || senderRole.isSuperAdmin;
          botIsAdmin = Boolean(group?.botIsAdmin);
          botIsSuperAdmin = Boolean(group?.botIsSuperAdmin);
        }

        const context = {
          slashCommand,
          chatId,
          chatType,
          senderId,
          senderIsAdmin,
          senderIsOwner: isOwnerJid(senderId),
          senderRole: isGroup
            ? roleFlagsForJid(group?.participantRoles, senderId)
            : { isAdmin: false, isSuperAdmin: false },
          senderDisplay: msg.pushName || "",
          botIsAdmin,
          botIsSuperAdmin,
          contextMsgId: msg.key.id,
          fromMe: Boolean(msg.key.fromMe),
          text,
          group,
          msg,
          account,
          sock,
        };

        await handleCommandListener(msg, context);
      } catch (err) {
        logger.error({ err }, "command listener error");
      }
    }
  });

  // Listener 2: Chatbot handler (send to Python)
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (!Array.isArray(messages) || messages.length === 0) return;
    const batchStartMs = Date.now();
    const isNotify = type === "notify";
    const precomputedContextByMessage = new Map<string, string>();

    if (!isNotify) {
      await runWithConcurrency(
        messages,
        config.upsertConcurrency,
        async (msg) => {
          try {
            const stubEvent = parseGroupJoinStub(msg);
            if (stubEvent) {
              await emitGroupJoinContextEvent(account, stubEvent);
            }
          } catch (err) {
            logger.error({ err }, "failed handling message");
          }
        },
      );
    } else {
      const notifyGroups = new Map<string, WAMessage[]>();
      for (const msg of messages) {
        const chatId = msg?.key?.remoteJid || "__unknown_chat__";
        const bucket = notifyGroups.get(chatId) || [];
        bucket.push(msg);
        notifyGroups.set(chatId, bucket);

        const messageId = msg?.key?.id;
        if (!chatId || !messageId || chatId === "status@broadcast") continue;
        if (
          GROUP_JOIN_STUB_TYPES.has(msg?.messageStubType as number) ||
          !msg?.message
        )
          continue;
        const contextMsgId = ensureContextMsgId(account, chatId, messageId);
        precomputedContextByMessage.set(
          messageIdIndexKey(chatId, messageId),
          contextMsgId,
        );
      }

      const groupedMessages = Array.from(notifyGroups.values());
      await runWithConcurrency(
        groupedMessages,
        config.upsertConcurrency,
        async (groupMessages) => {
          for (const msg of groupMessages) {
            try {
              const chatId = msg?.key?.remoteJid;
              const messageId = msg?.key?.id;
              const precomputedContextMsgId =
                chatId && messageId
                  ? precomputedContextByMessage.get(
                      messageIdIndexKey(chatId, messageId),
                    )
                  : null;
              await handleIncomingMessage(entry, msg, {
                precomputedContextMsgId,
              });
            } catch (err) {
              logger.error({ err }, "failed handling message");
            }
          }
        },
      );
    }

    const batchTotalMs = Date.now() - batchStartMs;
    if (
      config.perfLogEnabled &&
      messages.length > 1 &&
      batchTotalMs >= config.perfLogThresholdMs
    ) {
      logger.info(
        {
          type,
          messageCount: messages.length,
          upsertConcurrency: config.upsertConcurrency,
          chatGroups: isNotify
            ? new Set(
                messages.map(
                  (msg) => msg?.key?.remoteJid || "__unknown_chat__",
                ),
              ).size
            : null,
          batchTotalMs,
        },
        "slow messages.upsert batch",
      );
    }
  });
}
