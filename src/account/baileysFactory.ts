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
 * print) live in `wa/connection.ts`, and the inbound/event handlers in
 * `wa/inbound.ts` / `wa/events.ts`. Step 07: the factory imports ALL of them
 * STATICALLY (one-directional `account/ → wa/`); `wa/` no longer imports
 * `account/` at runtime (it forwards Baileys events back through the
 * {@link import('../protocol/ports.js').AccountForwarder} port on the context),
 * so the former `account/ ↔ wa/` cycle and its lazy `await import()`
 * workarounds are gone. The single-account `startWhatsApp()` boot shim now
 * lives here (in the factory) instead of `wa/connection.ts`.
 */
import path from "path";
import fs from "fs-extra";
import { randomInt } from "node:crypto";
import makeWASocket, {
  fetchLatestBaileysVersion,
  DisconnectReason,
} from "baileys";
import type { WASocket, WAMessage, AuthenticationState } from "baileys";
import { useCachedAuthState } from "../utils/cachedAuthState.js";
import logger, { baileysLogger } from "../logger.js";
import config from "../config.js";
import { createAccountContext } from "./accountContext.js";
import type { AccountContext } from "./accountContext.js";
import { forwardStatus, bindForwarder } from "./eventForwarder.js";
import * as registry from "../server/accountRegistry.js";
import type {
  AccountEntry,
  BaileysFactoryOptions,
  WaStatus,
} from "../protocol/types.js";
import { Database } from "../db/Database.js";
import { createRepositories } from "../db/repositories/index.js";
import {
  invalidateGroupMetadata,
  getGroupContext,
  parseGroupJoinStub,
} from "../wa/domain/groupContext.js";
import { parseSlashCommand } from "../wa/commands/index.js";
import {
  roleFlagsForJid,
  isOwnerJid,
  registerOwnerLid,
  resolveLidForPhone,
} from "../wa/domain/participants.js";
import {
  normalizeJid,
  ensureContextMsgId,
  messageIdIndexKey,
} from "../wa/domain/identifiers.js";
import { unwrapMessage, extractText } from "../wa/domain/messageParser.js";
import { runWithConcurrency } from "../wa/utils.js";
import { GROUP_JOIN_STUB_TYPES } from "../wa/domain/caches.js";
import type { GroupContextValue } from "../wa/domain/caches.js";
import { dispatchCommand } from "../wa/command/CommandRegistry.js";
import {
  handleButtonResponse,
  printQrInTerminal,
} from "../wa/connection.js";
import { handlePendingModelForm } from "../wa/commands/modelcfg.js";
import {
  handleIncomingMessage,
  handleGroupParticipantsUpdate,
} from "../wa/inbound.js";
import { emitGroupJoinContextEvent } from "../wa/events.js";

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
    // Hand Baileys our tamed child logger so its (very chatty) internal logging
    // is level-filtered (default 'warn') and rendered in the same clean format
    // as the gateway instead of its own raw-JSON 'info' default.
    logger: baileysLogger,
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
 * Resolve this tenant's media / sticker / sticker-upload directories
 * (CONTRACT.md §8). The DEFAULT single-account tenant (keyed by
 * `config.dataDir`) keeps the `config.*` globals so the existing env overrides
 * (`MEDIA_DIR`, `STICKERS_DIR`, `STICKER_UPLOAD_DIR`) and single-account layout
 * are byte-for-byte unchanged; every additional tenant gets its own
 * `<folderPath>/{media,stickers,stickers_user}` so two accounts never share a
 * media directory (and the attachment allowlist can't span tenants).
 */
export function resolveTenantMediaDirs(
  folderPath: string,
  layout: TenantLayout,
): { mediaDir: string; stickersDir: string; stickerUploadDir: string } {
  const isDefaultTenant =
    path.resolve(folderPath) === path.resolve(config.dataDir);
  if (isDefaultTenant) {
    return {
      mediaDir: config.mediaDir,
      stickersDir: config.stickersDir,
      stickerUploadDir: config.stickerUploadDir,
    };
  }
  return {
    mediaDir: layout.mediaDir,
    stickersDir: layout.stickersDir,
    stickerUploadDir: path.join(folderPath, "stickers_user"),
  };
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
 * Open this tenant's persistence (Step 05): construct ONE {@link Database}
 * pointed at `<folderPath>/db`, open it, build the per-domain repositories, and
 * store both on the {@link AccountEntry}. Idempotent — a no-op if the entry
 * already owns a `Database`, so repeated `hello`s / the boot-time default-tenant
 * open never reopen (and never clobber) live handles.
 *
 * Ownership is the `AccountEntry`: there is NO global registry of `Database`s
 * keyed by `folderPath`, so two tenants can never share connections.
 */
export function openAccountPersistence(entry: AccountEntry, dbDir: string): void {
  if (entry.database) return;
  const database = new Database(dbDir);
  database.open();
  entry.database = database;
  entry.repos = createRepositories(database);
  seedSubagentDefault(entry.repos);
}

// One-time seed of the per-tenant default sub-agent enablement from
// SUBAGENT_ENABLED_DEFAULT. The effective default for an untouched chat is the
// __global__ settings row (subagent_enabled, SQL-default 0), so the env had no
// effect before this. We seed it ONCE (guarded by a bot_config marker) and only
// ever turn it ON — never off — so an explicit `/subagent default on` (or the
// legacy `/subagent global on`) is never clobbered. Runtime
// `/subagent default on|off` overrides it afterwards.
export function seedSubagentDefault(repos: ReturnType<typeof createRepositories>): void {
  const SEED_MARKER = "subagent_default_seeded";
  if (repos.settings.getBotConfig(SEED_MARKER) !== null) return;
  if (config.subagentEnabledDefault && !repos.settings.getSubagentEnabled("__global__")) {
    repos.settings.setDefaultSubagentEnabled(true);
  }
  repos.settings.setBotConfig(SEED_MARKER, "1");
}

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

  // Per-tenant DB wiring (CONTRACT.md §8 / Step 05). The AccountEntry OWNS its
  // Database + repositories, opened against THIS tenant's `db/` dir. No-op if
  // already opened (e.g. the boot-time default-tenant open in index.ts).
  openAccountPersistence(entry, layout.dbDir);

  // Build the per-account state holder, reusing any existing context already
  // registered for this folder so object identity stays shared between the
  // message path and the action dispatcher.
  const existingCtx = entry.ctx as AccountContext;
  if (!existingCtx || !existingCtx.messageCache) {
    entry.ctx = createAccountContext(folderPath);
  }
  // Thread this tenant's repositories onto the context so every ctx-first
  // `wa/*` helper reaches THIS account's DBs via `ctx.repos` (mirrors `sock`).
  entry.ctx.repos = entry.repos;
  // Thread this tenant's media/sticker dirs (CONTRACT.md §8) so inbound media,
  // the attachment allowlist, and sticker temp writes stay inside THIS tenant's
  // folder instead of a process-global dir shared across accounts.
  const mediaDirs = resolveTenantMediaDirs(folderPath, layout);
  entry.ctx.mediaDir = mediaDirs.mediaDir;
  entry.ctx.stickersDir = mediaDirs.stickersDir;
  entry.ctx.stickerUploadDir = mediaDirs.stickerUploadDir;

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

  const { state, saveCreds } = await useCachedAuthState(authDir);

  const sock = await socketCreator(state as unknown as AuthenticationState);
  registry.bindSock(folderPath, sock);
  // Thread the live socket onto the per-account context so every ctx-first
  // `wa/*` helper, `groupContext`, and command handler reaches THIS account's
  // socket via `ctx.sock` (Step 33 — replaces the removed global socket accessor).
  // Refreshed here on every (re)build so reconnects rebind the new socket.
  account.sock = sock;
  // Step 07: bind the event forwarder so `wa/` (inbound/events) push Baileys
  // events to the Python client via the AccountForwarder PORT on the context,
  // instead of importing `account/eventForwarder.js` concretely (breaks the
  // `account/ ↔ wa/` cycle). Refreshed on every (re)build alongside `sock`.
  account.forwarder = bindForwarder(entry);

  sock.ev.on("creds.update", saveCreds);

  // Event-listener wiring is split out of socket creation (Step 07): one small
  // single-purpose attacher per Baileys event family.
  attachConnectionListener(sock, entry, authDir, opts, printQr);
  attachGroupListeners(sock, account);
  attachCommandListener(sock, entry, account);
  attachChatbotListener(sock, entry, account);
}

// ---------------------------------------------------------------------------
// Event-listener wiring (Step 07 — extracted from buildSocket)
// ---------------------------------------------------------------------------

/**
 * Crockford base32 alphabet WhatsApp uses for pairing codes (matches Baileys'
 * own `bytesToCrockford` charset: no `0`, `I`, `O`, `U`). A custom pairing code
 * MUST be exactly 8 chars from this set or WhatsApp rejects it.
 */
const PAIRING_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTVWXYZ";

/** Generate a valid 8-char WhatsApp pairing code from the Crockford alphabet. */
function generatePairingCode(): string {
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  }
  return code;
}

/**
 * Request an 8-char WhatsApp pairing code for `phoneNumber` (digits only, with
 * country code) and surface it prominently on stdout + the structured log, so a
 * headless deploy (e.g. Pterodactyl console) can pair WITHOUT a QR. WhatsApp
 * formats the code as `XXXX-XXXX` in the Linked Devices UI.
 *
 * The caller passes a STABLE `customCode` (stored on the AccountEntry) so that a
 * transient reconnect — which rebuilds the socket and re-requests the code —
 * re-displays the SAME code instead of minting a fresh one. Without this, a
 * `restartRequired` (515) / `connectionClosed` (428) close during the pairing
 * window would invalidate the code the user is currently typing, which is the
 * classic "pairing code keeps failing" symptom.
 *
 * Best-effort: on failure it logs the error and falls back to printing the QR
 * (when `fallbackQr` is provided), so a transient pairing-code failure never
 * leaves the operator with no way to authenticate.
 */
function requestPairingCode(
  sock: WASocket,
  phoneNumber: string,
  customCode: string,
  folderPath: string,
  fallbackQr: string | null,
): void {
  sock
    .requestPairingCode(phoneNumber, customCode)
    .then((code) => {
      const pretty =
        typeof code === "string" && code.length === 8
          ? `${code.slice(0, 4)}-${code.slice(4)}`
          : code;
      logger.info(
        { folderPath, phoneNumber, code: pretty },
        "WhatsApp pairing code generated",
      );
      // Loud stdout banner so it's unmissable in a deploy console.
      console.log(
        `\n================ WhatsApp Pairing Code ================\n` +
          `  Number : ${phoneNumber}\n` +
          `  Code   : ${pretty}\n` +
          `  Steps  : WhatsApp > Linked Devices > Link a Device >\n` +
          `           Link with phone number  →  enter the code above\n` +
          `======================================================\n`,
      );
    })
    .catch((err) => {
      logger.error(
        { err, folderPath, phoneNumber },
        "failed to request pairing code; falling back to QR if available",
      );
      if (fallbackQr) printQrInTerminal(fallbackQr);
    });
}

/**
 * Resolve every configured owner *phone number* to its WhatsApp LID and register
 * it for owner detection. WhatsApp addresses group senders by an opaque LID, so
 * a phone-number-only BOT_OWNER_JIDS would otherwise never match in groups.
 * Best-effort: failures are logged at debug and never block the connection.
 */
async function resolveOwnerLids(sock: WASocket): Promise<void> {
  const numbers = new Set<string>();
  for (const entry of config.botOwnerJids) {
    if (entry.includes("@lid")) continue; // already a LID
    const digits = entry.replace(/\D/g, "");
    if (digits.length >= 5) numbers.add(digits);
  }
  for (const digits of numbers) {
    try {
      const lid = await resolveLidForPhone(sock, digits);
      if (lid && registerOwnerLid(lid)) {
        logger.info({ phone: digits, lid }, "resolved owner LID");
      }
    } catch (err) {
      logger.debug({ err, digits }, "owner LID resolution failed");
    }
  }
}

/**
 * Connection-state listener: QR printing, normalized `whatsapp_status`
 * forwarding (exactly once), the `onStatusChange` side-hook, and the
 * reconnect/logged-out branch (which rebuilds only the socket via
 * {@link buildSocket}, preserving folder/DB/context setup).
 */
function attachConnectionListener(
  sock: WASocket,
  entry: AccountEntry,
  authDir: string,
  opts: BaileysFactoryOptions,
  printQr: boolean,
): void {
  const folderPath = entry.folderPath;
  // Guard so the pairing code is requested at most once per socket build (the
  // `qr` field re-emits every ~20s while unregistered, and each request would
  // otherwise mint a NEW code, confusing the user).
  let pairingRequested = false;
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      // Pairing-code flow (no QR): when WA_PAIRING_NUMBER is configured and this
      // device isn't registered yet, request an 8-char pairing code instead of
      // rendering a QR. The `qr` event is the signal that the socket is ready to
      // issue a pairing code. Falls back to QR if the request fails.
      const pairingNumber = config.pairingNumber;
      const registered = Boolean((sock as any)?.authState?.creds?.registered);
      if (pairingNumber && !registered) {
        if (!pairingRequested) {
          pairingRequested = true;
          // Reuse a STABLE custom code across socket rebuilds so a transient
          // reconnect mid-pairing doesn't invalidate the code the user is typing.
          if (!entry.pairingCode) entry.pairingCode = generatePairingCode();
          requestPairingCode(
            sock,
            pairingNumber,
            entry.pairingCode,
            folderPath,
            printQr ? qr : null,
          );
        }
      } else if (printQr) {
        logger.info("Scan QR to authenticate (valid for 20 seconds)");
        printQrInTerminal(qr);
      }
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
      // Pairing succeeded (or wasn't needed): drop the stored code so a future
      // re-pair mints a fresh one.
      entry.pairingCode = undefined;
      // Step 18: forward the normalized `whatsapp_status` exactly once.
      forwardStatus(entry, status);
      // Resolve configured owner phone numbers to their WhatsApp LIDs so
      // owner detection keeps working when group senders arrive as `@lid`.
      resolveOwnerLids(sock).catch((err) =>
        logger.debug({ err, folderPath }, "resolveOwnerLids failed"),
      );
    }
    try {
      opts.onStatusChange?.(status);
    } catch (err) {
      logger.error({ err }, "onStatusChange handler failed");
    }
  });
}

/** Group-metadata invalidation + group-participants (join/role-change) listeners. */
function attachGroupListeners(sock: WASocket, account: AccountContext): void {
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
}

/**
 * True when a WhatsApp message is older than `config.staleMessageMaxAgeMs`
 * (default 5s) and should be ignored.
 *
 * When the Baileys socket reconnects after being offline, WhatsApp flushes the
 * messages that queued up while it was disconnected through `messages.upsert`
 * (`type: "notify"`) — exactly like real-time delivery. Without this gate the
 * bot processes/responds to that entire backlog at once ("goes crazy"). Live
 * messages arrive within ~1-2s, so anything older than the threshold is treated
 * as backlog and dropped.
 *
 * Fails OPEN: a message with no usable `messageTimestamp` (0/missing/invalid) is
 * kept. Set `STALE_MESSAGE_MAX_AGE_MS=0` to disable the gate entirely.
 */
export function isStaleMessage(msg: WAMessage, nowMs: number = Date.now()): boolean {
  const maxAgeMs = config.staleMessageMaxAgeMs;
  if (maxAgeMs <= 0) return false;
  const tsMs = Number(msg?.messageTimestamp) * 1000;
  if (!(tsMs > 0)) return false;
  return nowMs - tsMs > maxAgeMs;
}

/**
 * Listener 1 — command handler (non-blocking, instant response): interactive
 * button replies, pending `/modelcfg` form replies, then slash-command dispatch.
 */
function attachCommandListener(
  sock: WASocket,
  entry: AccountEntry,
  account: AccountContext,
): void {
  const folderPath = entry.folderPath;
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
        // Ignore the offline backlog WhatsApp flushes on reconnect (see
        // isStaleMessage) so old slash commands don't re-execute in a burst.
        if (isStaleMessage(msg)) continue;
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

        if (await handlePendingModelForm(account, sock, folderPath, chatId, senderId, text)) {
          continue;
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
          repos: account.repos,
        };

        await dispatchCommand(msg, context);
      } catch (err) {
        logger.error({ err }, "command listener error");
      }
    }
  });
}

/** Listener 2 — chatbot handler: normalize + forward inbound messages to Python. */
function attachChatbotListener(
  sock: WASocket,
  entry: AccountEntry,
  account: AccountContext,
): void {
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (!Array.isArray(messages) || messages.length === 0) return;
    // Drop the offline backlog WhatsApp flushes on reconnect (see
    // isStaleMessage) so the bot doesn't respond to a flood of stale messages.
    const nowMs = Date.now();
    const liveMessages = messages.filter((msg) => !isStaleMessage(msg, nowMs));
    if (liveMessages.length === 0) return;
    const batchStartMs = Date.now();
    const isNotify = type === "notify";
    const precomputedContextByMessage = new Map<string, string>();

    if (!isNotify) {
      await runWithConcurrency(
        liveMessages,
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
      for (const msg of liveMessages) {
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
      liveMessages.length > 1 &&
      batchTotalMs >= config.perfLogThresholdMs
    ) {
      logger.info(
        {
          type,
          messageCount: liveMessages.length,
          upsertConcurrency: config.upsertConcurrency,
          chatGroups: isNotify
            ? new Set(
                liveMessages.map(
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

/**
 * Initialize and start the WhatsApp socket for the single-account live boot.
 *
 * Step 07: moved here from `wa/connection.ts` (it lazy-imported this factory,
 * forming the `account/ ↔ wa/` cycle). It creates/resumes the DEFAULT account
 * (keyed by `config.dataDir`) and returns its live socket.
 *
 * `whatsapp_status` forwarding happens inside the factory's `connection.update`
 * via `eventForwarder.forwardStatus` (exactly once); the `onStatusChange` hook
 * is a logging/extension side-hook only.
 *
 * @returns The connected (default account) socket instance.
 */
export async function startWhatsApp(): Promise<WASocket> {
  const entry = await createOrResumeAccount({
    folderPath: config.dataDir,
    printQr: true,
    onStatusChange: (status, reason) => {
      logger.debug(
        { status, reason, folderPath: config.dataDir },
        "whatsapp status change",
      );
    },
  });
  return entry.sock as WASocket;
}
