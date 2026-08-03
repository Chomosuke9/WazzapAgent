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
import makeWASocket, {
  Browsers,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  DisconnectReason,
} from "baileys";
import type { WASocket, WAMessage, AuthenticationState } from "baileys";
import { useCachedAuthState } from "../utils/cachedAuthState.js";
import logger, { baileysLogger } from "../logger.js";
import config from "../config.js";
import { createAccountContext } from "./accountContext.js";
import type { AccountContext } from "./accountContext.js";
import {
  forwardStatus,
  bindForwarder,
  normalizeWaStatus,
} from "./eventForwarder.js";
import * as registry from "../server/accountRegistry.js";
import type { AccountEntry, BaileysFactoryOptions } from "../protocol/types.js";
import { Database } from "../db/Database.js";
import { createRepositories } from "../db/repositories/index.js";
import {
  invalidateGroupMetadata,
  getGroupContext,
  parseGroupJoinStub,
} from "../wa/domain/groupContext.js";
import { cacheSetBounded, MAX_CACHE } from "../wa/domain/caches.js";
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
import { handleButtonResponse, printQrInTerminal } from "../wa/connection.js";
import { handlePendingModelForm } from "../wa/commands/modelcfg.js";
import {
  checkBotAddedDirect,
  handleIncomingMessage,
  handleGroupParticipantsUpdate,
} from "../wa/inbound.js";
import { emitGroupJoinContextEvent, emitBotAddedEvent } from "../wa/events.js";
import { currentBotAliases } from "../wa/domain/groupContext.js";
import { compactParticipantJids } from "../wa/domain/participants.js";
import { shouldIgnorePrivateChat } from "../wa/privateChat.js";
import {
  getTenantBotName,
  getTenantBotOwnerJids,
  seedTenantLlmProviderConfig,
  seedTenantIdentity,
} from "../wa/botConfig.js";

// ---------------------------------------------------------------------------
// Test seam: socket creator
// ---------------------------------------------------------------------------

/** Creates a live Baileys {@link WASocket} from a prepared auth state. */
type SocketCreator = (authState: AuthenticationState) => Promise<WASocket>;

const defaultSocketCreator: SocketCreator = async (authState) => {
  let version: [number, number, number];
  try {
    ({ version } = await fetchLatestWaWebVersion({}));
    logger.info({ version }, "loaded live whatsapp web version");
  } catch (err) {
    logger.warn(
      { err },
      "failed to load live whatsapp web version; falling back to baileys version",
    );
    ({ version } = await fetchLatestBaileysVersion());
    logger.info({ version }, "loaded fallback baileys version");
  }

  logger.info({ version }, "starting whatsapp socket");
  return makeWASocket({
    version,
    auth: authState,
    syncFullHistory: false,
    // Pairing is sensitive to contradictory/unknown platform identities.
    // Use Baileys' canonical tuple instead of a branded browser identity.
    browser: Browsers.windows("Chrome"),
    markOnlineOnConnect: true,
    defaultQueryTimeoutMs: config.sendTimeoutMs,
    // Hand Baileys our tamed child logger so its (very chatty) internal logging
    // is level-filtered (default 'warn') and rendered in the same clean format
    // as the gateway instead of its own raw-JSON 'info' default.
    logger: baileysLogger,
  });
};

let socketCreator: SocketCreator = defaultSocketCreator;
let qrPrinter: (qr: string) => void = printQrInTerminal;

/**
 * Per-tenant socket builds currently in flight. Both the initial
 * `createOrResumeAccount` path and Baileys reconnects must share this
 * coordinator: otherwise a Python `hello` arriving while WhatsApp is
 * reconnecting can create a second socket against the same auth directory.
 */
const socketBuilds = new Map<string, Promise<void>>();

export type PairingCodeErrorCode =
  | "invalid_phone"
  | "already_linked"
  | "cooldown"
  | "busy"
  | "not_ready"
  | "request_failed"
  | "timeout";

/** Operator-facing error with a stable API code for the control panel. */
export class PairingCodeError extends Error {
  readonly code: PairingCodeErrorCode;
  readonly retryAfterMs?: number;

  constructor(
    code: PairingCodeErrorCode,
    message: string,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "PairingCodeError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface PairingCodeResult {
  code: string;
  phoneNumber: string;
  generatedAtMs: number;
}

interface PendingPairingRequest {
  phoneNumber: string;
  promise: Promise<PairingCodeResult>;
  resolve: (result: PairingCodeResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  started: boolean;
}

interface CachedPairingCode extends PairingCodeResult {
  reuseUntilMs: number;
}

const pendingPairingRequests = new Map<string, PendingPairingRequest>();
const cachedPairingCodes = new Map<string, CachedPairingCode>();
const pairingReadySockets = new WeakSet<WASocket>();
const PAIRING_REQUEST_TIMEOUT_MS = 45_000;
const PAIRING_CODE_REUSE_MS = 2 * 60_000;

/**
 * TEST SEAM — override the Baileys socket creator so tests run fully offline
 * (no version-fetch network call, no real socket). Pass `null` to restore the
 * default creator.
 */
export function __setSocketCreatorForTests(fn: SocketCreator | null): void {
  socketCreator = fn ?? defaultSocketCreator;
}

/** TEST SEAM - count terminal QR renders without spawning qrencode. */
export function __setQrPrinterForTests(
  fn: ((qr: string) => void) | null,
): void {
  qrPrinter = fn ?? printQrInTerminal;
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
export function openAccountPersistence(
  entry: AccountEntry,
  dbDir: string,
): void {
  if (entry.database) return;
  const database = new Database(dbDir);
  database.open();
  entry.database = database;
  entry.repos = createRepositories(database);
  seedTenantIdentity(entry.repos);
  seedTenantLlmProviderConfig(entry.repos);
  seedSubagentDefault(entry.repos);
}

// One-time seed of the per-tenant default sub-agent enablement from
// SUBAGENT_ENABLED_DEFAULT. The effective default for an untouched chat is the
// __global__ settings row (subagent_enabled, SQL-default 0), so the env had no
// effect before this. We seed it ONCE (guarded by a bot_config marker) and only
// ever turn it ON — never off — so an explicit `/subagent default on` (or the
// legacy `/subagent global on`) is never clobbered. Runtime
// `/subagent default on|off` overrides it afterwards.
export function seedSubagentDefault(
  repos: ReturnType<typeof createRepositories>,
): void {
  const SEED_MARKER = "subagent_default_seeded";
  if (repos.settings.getBotConfig(SEED_MARKER) !== null) return;
  if (
    config.subagentEnabledDefault &&
    !repos.settings.getSubagentEnabled("__global__")
  ) {
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
  entry.ctx.botName = getTenantBotName(entry.repos!);
  entry.ctx.botOwnerJids = getTenantBotOwnerJids(entry.repos!);
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

  await ensureSocketBuilt(entry, layout.authDir, opts);
  return entry;
}

/**
 * Ensure at most one socket build runs for a tenant at a time. The promise is
 * removed after success or failure so a later call can retry a failed build.
 */
async function ensureSocketBuilt(
  entry: AccountEntry,
  authDir: string,
  opts: BaileysFactoryOptions,
): Promise<void> {
  if (entry.sock) return;

  const existing = socketBuilds.get(entry.folderPath);
  if (existing) {
    await existing;
    return;
  }

  if (
    entry.pairingRetryAfterMs &&
    entry.pairingRetryAfterMs > Date.now()
  ) {
    logger.warn(
      {
        folderPath: entry.folderPath,
        retryAfter: new Date(entry.pairingRetryAfterMs).toISOString(),
      },
      "WhatsApp initial pairing is cooling down; restart manually to retry now",
    );
    return;
  }
  entry.pairingRetryAfterMs = undefined;

  const build = buildSocket(entry, authDir, opts);
  socketBuilds.set(entry.folderPath, build);
  try {
    await build;
  } finally {
    // Identity guard: never let an older build clear a newer coordinator.
    if (socketBuilds.get(entry.folderPath) === build) {
      socketBuilds.delete(entry.folderPath);
    }
  }
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
  // Make every relayed message catchable via `/catch`. Interactive messages
  // (buttons, carousel, copy-code, rich messages, the /setting & /modelcfg
  // menus, quiz, …) and Lottie stickers are sent with `relayMessage`, NOT
  // `sendMessage`, and a bot's own sends are never echoed back to the sending
  // socket — so without this they'd never land in `ctx.messageCache` and a
  // reply + `/catch` couldn't resolve them. One interception point here covers
  // all of them, with no change to the individual senders. Re-applied on every
  // (re)build so reconnects keep the wrapped socket.
  installRelayMessageCache(account);
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

/**
 * Wrap `account.sock.relayMessage` so every relayed proto is remembered in
 * `account.messageCache` (keyed by its wamid), making bot-sent interactive
 * messages resolvable for `/catch` and other reply-target lookups.
 *
 * Cache-only (no contextMsgId allocation), so it's harmless next to callers
 * that ALSO run the full `rememberMessage` afterwards (e.g. text replies via
 * `sendOutgoing`, `send_quiz`, Lottie stickers): the `messageCache` write is
 * idempotent and no contextMsgId is burned twice. The reconstructed
 * `{ key, message }` is exactly what `resolveQuotedMessage` / `/catch` read.
 *
 * No-op when the socket has no `relayMessage` (e.g. the test FakeSock).
 */
export function installRelayMessageCache(account: AccountContext): void {
  const sock = account.sock;
  if (!sock || typeof sock.relayMessage !== "function") return;
  const relay = sock.relayMessage.bind(sock) as WASocket["relayMessage"];
  type RelayParams = Parameters<WASocket["relayMessage"]>;
  sock.relayMessage = (async (
    jid: RelayParams[0],
    message: RelayParams[1],
    options: RelayParams[2],
  ) => {
    const result = await relay(jid, message, options);
    const messageId = (options as { messageId?: string } | undefined)
      ?.messageId;
    if (messageId && typeof jid === "string") {
      cacheSetBounded(
        account.messageCache,
        messageId,
        {
          key: { id: messageId, remoteJid: jid, fromMe: true },
          message,
        } as WAMessage,
        MAX_CACHE,
      );
    }
    return result;
  }) as WASocket["relayMessage"];
}

// ---------------------------------------------------------------------------
// Event-listener wiring (Step 07 — extracted from buildSocket)
// ---------------------------------------------------------------------------

/** Format Baileys' native eight-character code for human entry. */
function formatPairingCode(code: string): string {
  const compact = code.replace(/[^a-zA-Z0-9]/g, "");
  return compact.length === 8
    ? `${compact.slice(0, 4)}-${compact.slice(4)}`
    : code;
}

function maskPairingPhone(phoneNumber: string): string {
  if (phoneNumber.length <= 6) return "***";
  return `${phoneNumber.slice(0, 3)}***${phoneNumber.slice(-3)}`;
}

/** Let Baileys generate and bind a code to the current auth state. */
async function requestNativePairingCode(
  sock: WASocket,
  phoneNumber: string,
): Promise<PairingCodeResult> {
  const code = await sock.requestPairingCode(phoneNumber);
  return {
    code: formatPairingCode(code),
    phoneNumber,
    generatedAtMs: Date.now(),
  };
}

function cachePairingCode(
  folderPath: string,
  result: PairingCodeResult,
): void {
  cachedPairingCodes.set(folderPath, {
    ...result,
    reuseUntilMs: Date.now() + PAIRING_CODE_REUSE_MS,
  });
}

function clearPendingPairing(
  folderPath: string,
  request: PendingPairingRequest,
): void {
  if (pendingPairingRequests.get(folderPath) !== request) return;
  clearTimeout(request.timeout);
  pendingPairingRequests.delete(folderPath);
}

function rejectPendingPairing(folderPath: string, error: Error): void {
  const request = pendingPairingRequests.get(folderPath);
  if (!request) return;
  clearPendingPairing(folderPath, request);
  request.reject(error);
}

/** Complete a queued control-panel request once this socket has emitted QR. */
async function fulfillPendingPairing(
  entry: AccountEntry,
  sock: WASocket,
): Promise<void> {
  const request = pendingPairingRequests.get(entry.folderPath);
  if (!request || request.started || entry.sock !== sock) return;
  request.started = true;
  entry.pairingPhoneNumber = request.phoneNumber;
  entry.pairingRequestedAtMs = Date.now();
  try {
    const result = await requestNativePairingCode(sock, request.phoneNumber);
    if (
      pendingPairingRequests.get(entry.folderPath) !== request
      || entry.sock !== sock
    ) {
      return;
    }
    cachePairingCode(entry.folderPath, result);
    request.resolve(result);
    logger.info(
      {
        folderPath: entry.folderPath,
        phoneNumber: maskPairingPhone(request.phoneNumber),
      },
      "WhatsApp pairing code generated for control panel",
    );
  } catch (err) {
    entry.pairingRetryAfterMs = Date.now() + config.pairingRetryCooldownMs;
    entry.pairingPhoneNumber = undefined;
    entry.pairingRequestedAtMs = undefined;
    request.reject(
      new PairingCodeError(
        "request_failed",
        err instanceof Error
          ? err.message
          : "WhatsApp rejected the pairing request.",
        entry.pairingRetryAfterMs,
      ),
    );
    logger.error(
      {
        err,
        folderPath: entry.folderPath,
        phoneNumber: maskPairingPhone(request.phoneNumber),
      },
      "failed to request control-panel pairing code",
    );
  } finally {
    clearPendingPairing(entry.folderPath, request);
  }
}

/** Existing headless `.env` pairing flow, retained for console deployments. */
function requestConfiguredPairingCode(
  sock: WASocket,
  entry: AccountEntry,
  phoneNumber: string,
  fallbackQr: string | null,
): void {
  entry.pairingPhoneNumber = phoneNumber;
  entry.pairingRequestedAtMs = Date.now();
  requestNativePairingCode(sock, phoneNumber)
    .then((result) => {
      if (
        entry.sock !== sock
        || entry.pairingPhoneNumber !== phoneNumber
        || (entry.pairingRetryAfterMs ?? 0) > Date.now()
      ) {
        return;
      }
      cachePairingCode(entry.folderPath, result);
      logger.info(
        {
          folderPath: entry.folderPath,
          phoneNumber: maskPairingPhone(phoneNumber),
        },
        "WhatsApp pairing code generated",
      );
      console.log(
        `\n================ WhatsApp Pairing Code ================\n` +
          `  Number : ${phoneNumber}\n` +
          `  Code   : ${result.code}\n` +
          `  Steps  : WhatsApp > Linked Devices > Link a Device >\n` +
          `           Link with phone number  →  enter the code above\n` +
          `======================================================\n`,
      );
    })
    .catch((err) => {
      entry.pairingRetryAfterMs = Date.now() + config.pairingRetryCooldownMs;
      entry.pairingPhoneNumber = undefined;
      entry.pairingRequestedAtMs = undefined;
      logger.error(
        {
          err,
          folderPath: entry.folderPath,
          phoneNumber: maskPairingPhone(phoneNumber),
        },
        "failed to request pairing code; falling back to QR if available",
      );
      if (fallbackQr) qrPrinter(fallbackQr);
    });
}

/**
 * Queue a native pairing-code request for an existing tenant. Repeated clicks
 * for the same number reuse the recent code instead of minting conflicting
 * codes; a rejected attempt observes the console flow's cooldown.
 */
export async function requestAccountPairingCode(
  folderPath: string,
  rawPhoneNumber: string,
): Promise<PairingCodeResult> {
  const phoneNumber = rawPhoneNumber.replace(/\D/g, "");
  if (phoneNumber.length < 8 || phoneNumber.length > 15) {
    throw new PairingCodeError(
      "invalid_phone",
      "Use 8-15 digits including the country code.",
    );
  }

  const entry = registry.getOrCreate(folderPath);
  if (entry.sock?.authState?.creds?.registered || entry.waStatus === "open") {
    throw new PairingCodeError(
      "already_linked",
      "This WhatsApp account is already linked.",
    );
  }

  const now = Date.now();
  if (entry.pairingRetryAfterMs && entry.pairingRetryAfterMs > now) {
    throw new PairingCodeError(
      "cooldown",
      "Pairing is cooling down after a failed attempt.",
      entry.pairingRetryAfterMs,
    );
  }

  const cached = cachedPairingCodes.get(folderPath);
  if (cached && cached.reuseUntilMs > now) {
    if (cached.phoneNumber === phoneNumber) return cached;
    throw new PairingCodeError(
      "busy",
      "A recent pairing code exists for another phone number.",
      cached.reuseUntilMs,
    );
  }
  if (cached) cachedPairingCodes.delete(folderPath);

  const existing = pendingPairingRequests.get(folderPath);
  if (existing) {
    if (existing.phoneNumber === phoneNumber) return existing.promise;
    throw new PairingCodeError(
      "busy",
      "Another pairing request is already in progress for this account.",
    );
  }

  let resolveRequest!: (result: PairingCodeResult) => void;
  let rejectRequest!: (error: Error) => void;
  const promise = new Promise<PairingCodeResult>((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  const request = {
    phoneNumber,
    promise,
    resolve: resolveRequest,
    reject: rejectRequest,
    timeout: setTimeout(() => {}, PAIRING_REQUEST_TIMEOUT_MS),
    started: false,
  } satisfies PendingPairingRequest;
  clearTimeout(request.timeout);
  request.timeout = setTimeout(() => {
    if (pendingPairingRequests.get(folderPath) !== request) return;
    clearPendingPairing(folderPath, request);
    entry.pairingPhoneNumber = undefined;
    entry.pairingRequestedAtMs = undefined;
    request.reject(
      new PairingCodeError(
        "timeout",
        "WhatsApp did not become ready for pairing in time. Reconnect and try again.",
      ),
    );
  }, PAIRING_REQUEST_TIMEOUT_MS);
  request.timeout.unref?.();
  pendingPairingRequests.set(folderPath, request);
  entry.pairingPhoneNumber = phoneNumber;
  entry.pairingRequestedAtMs = now;

  void (async () => {
    try {
      await createOrResumeAccount({ folderPath, printQr: false });
      const sock = entry.sock;
      if (!sock) {
        throw new PairingCodeError(
          "not_ready",
          "The WhatsApp socket could not be started.",
        );
      }
      if (sock.authState?.creds?.registered) {
        throw new PairingCodeError(
          "already_linked",
          "This WhatsApp account is already linked.",
        );
      }
      if (pairingReadySockets.has(sock)) {
        await fulfillPendingPairing(entry, sock);
      }
    } catch (err) {
      if (pendingPairingRequests.get(folderPath) !== request) return;
      clearPendingPairing(folderPath, request);
      entry.pairingPhoneNumber = undefined;
      entry.pairingRequestedAtMs = undefined;
      request.reject(
        err instanceof Error
          ? err
          : new PairingCodeError("request_failed", "Pairing request failed."),
      );
    }
  })();

  return promise;
}

function detachSocket(entry: AccountEntry): WASocket | undefined {
  const sock = entry.sock;
  entry.sock = undefined;
  if (entry.ctx.sock === sock) entry.ctx.sock = undefined;
  entry.waStatus = "close";
  entry.pairingPhoneNumber = undefined;
  entry.pairingRequestedAtMs = undefined;
  cachedPairingCodes.delete(entry.folderPath);
  rejectPendingPairing(
    entry.folderPath,
    new PairingCodeError("not_ready", "The account connection was reset."),
  );
  if (sock) pairingReadySockets.delete(sock);
  return sock;
}

/**
 * Remove only the Baileys session files so a logged-out tenant can start a
 * genuinely fresh pairing flow. Settings, history, media, and stickers stay
 * tenant-local and are intentionally preserved.
 */
function clearAuthSession(authDir: string, folderPath: string): void {
  try {
    fs.emptyDirSync(authDir);
    logger.info({ folderPath }, "cleared logged-out WhatsApp auth session");
  } catch (err) {
    logger.error(
      { err, folderPath, authDir },
      "failed to clear logged-out WhatsApp auth session",
    );
  }
}

/** Rebuild one tenant's WhatsApp socket without touching its auth or DBs. */
export async function reconnectAccount(folderPath: string): Promise<AccountEntry> {
  const entry = registry.get(folderPath);
  if (!entry) throw new Error("Account not found.");
  entry.pairingRetryAfterMs = undefined;
  const previous = detachSocket(entry);
  if (previous) {
    try {
      previous.end(new Error("Manual reconnect from control panel"));
    } catch (err) {
      logger.debug({ err, folderPath }, "manual reconnect: old socket end failed");
    }
  }
  return createOrResumeAccount({ folderPath, printQr: false });
}

/**
 * Explicit destructive session reset used by the control panel's confirmed
 * Disconnect action. The tenant DB/media remain intact; only WhatsApp auth is
 * removed so the next action can start a fresh pairing flow.
 */
export async function disconnectAccount(folderPath: string): Promise<void> {
  const entry = registry.get(folderPath);
  if (!entry) throw new Error("Account not found.");
  entry.pairingRetryAfterMs = undefined;
  const previous = detachSocket(entry);
  if (previous) {
    try {
      await Promise.race([
        previous.logout(),
        new Promise<void>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("WhatsApp logout timed out")),
            10_000,
          );
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      logger.warn({ err, folderPath }, "control panel logout failed; clearing local auth");
      try {
        previous.end(new Error("Control panel session reset"));
      } catch {
        // The socket may already be closed; local auth clearing remains valid.
      }
    }
  }
  const { authDir } = ensureFolderLayout(folderPath);
  await fs.emptyDir(authDir);
  forwardStatus(entry, "close", DisconnectReason.loggedOut);
  logger.info({ folderPath }, "WhatsApp session disconnected from control panel");
}

/**
 * Stop one tenant without deleting its auth, databases, media, or stickers.
 * Used when an operator removes the account from the managed catalog. The
 * bridge client is closed and the in-memory registry entry is released; a
 * catalog tombstone in accountRegistry guards the brief hot-reload race.
 */
export async function stopAccount(folderPath: string): Promise<void> {
  const entry = registry.get(folderPath);
  if (!entry) return;

  const previous = detachSocket(entry);
  if (previous) {
    try {
      previous.end(new Error("Account removed from managed catalog"));
    } catch (err) {
      logger.debug({ err, folderPath }, "removed account socket was already closed");
    }
  }

  const client = entry.client;
  if (client) {
    registry.unbindClient(folderPath, client);
    try {
      client.close(1000, "account removed");
    } catch (err) {
      logger.debug({ err, folderPath }, "removed account bridge was already closed");
    }
  }

  try {
    entry.database?.close();
  } catch (err) {
    logger.warn({ err, folderPath }, "failed closing removed account database");
  }
  entry.database = undefined;
  entry.repos = undefined;
  registry.remove(folderPath);
  logger.info({ folderPath }, "account runtime stopped; tenant data preserved");
}

/**
 * Resolve every configured owner *phone number* to its WhatsApp LID and register
 * it for owner detection. WhatsApp addresses group senders by an opaque LID, so
 * a phone-number-only BOT_OWNER_JIDS would otherwise never match in groups.
 * Best-effort: failures are logged at debug and never block the connection.
 */
async function resolveOwnerLids(sock: WASocket, ownerJids: string[]): Promise<void> {
  const numbers = new Set<string>();
  for (const entry of ownerJids) {
    if (entry.includes("@lid")) continue; // already a LID
    const digits = entry.replace(/\D/g, "");
    if (digits.length >= 5) numbers.add(digits);
  }
  for (const digits of numbers) {
    try {
      const lid = await resolveLidForPhone(sock, digits);
      if (lid && registerOwnerLid(lid, ownerJids)) {
        logger.info({ phone: digits, lid }, "resolved owner LID");
      }
    } catch (err) {
      logger.debug({ err, digits }, "owner LID resolution failed");
    }
  }
}

/** Resolve owner phone numbers immediately for a live tenant socket. */
export async function resolveAccountOwnerLids(folderPath: string): Promise<void> {
  const entry = registry.get(folderPath);
  if (!entry?.sock || !entry.ctx.botOwnerJids) return;
  await resolveOwnerLids(entry.sock, entry.ctx.botOwnerJids);
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
  // A Baileys socket refreshes its QR roughly every 20 seconds. Appending every
  // refresh to tmux/Pterodactyl logs creates an endless wall of QR blocks, so
  // show only the first one for this socket generation. Operators can request a
  // fresh native pairing code from the control panel or reconnect explicitly.
  let terminalQrPrinted = false;
  sock.ev.on("connection.update", (update) => {
    // A replaced socket can still deliver a queued/delayed update. Only the
    // socket currently bound to this tenant may mutate status or trigger a
    // rebuild; otherwise a stale close can tear down its live replacement.
    if (entry.sock !== sock) {
      logger.debug(
        { folderPath, connection: update.connection },
        "ignoring connection update from stale WhatsApp socket",
      );
      return;
    }

    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      pairingReadySockets.add(sock);
      // An authenticated control-panel request takes precedence over the
      // static WA_PAIRING_NUMBER flow for this socket. The pending map is the
      // at-most-once guard, even when Baileys refreshes QR every ~20 seconds.
      if (pendingPairingRequests.has(folderPath)) {
        void fulfillPendingPairing(entry, sock);
      }
      // Pairing-code flow (no QR): when WA_PAIRING_NUMBER is configured and this
      // device isn't registered yet, request an 8-char pairing code instead of
      // rendering a QR. The `qr` event is the signal that the socket is ready to
      // issue a pairing code. Falls back to QR if the request fails.
      const pairingNumber = config.pairingNumber;
      const registered = Boolean(sock?.authState?.creds?.registered);
      if (
        !pendingPairingRequests.has(folderPath)
        && pairingNumber
        && !registered
      ) {
        if (!pairingRequested) {
          pairingRequested = true;
          requestConfiguredPairingCode(
            sock,
            entry,
            pairingNumber,
            printQr ? qr : null,
          );
        }
      } else if (
        !pendingPairingRequests.has(folderPath)
        && printQr
        && !terminalQrPrinted
      ) {
        terminalQrPrinted = true;
        logger.info(
          "Scan QR to authenticate (shown once); use the control panel or reconnect for a fresh pairing attempt",
        );
        qrPrinter(qr);
      }
    }
    if (!connection) return;

    const status = normalizeWaStatus(connection);
    entry.waStatus = status;

    if (status === "close") {
      const statusCode = (
        lastDisconnect?.error as
          | { output?: { statusCode?: number } }
          | undefined
      )?.output?.statusCode;
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
      // Clear both canonical references while reconnecting so ctx-first action
      // helpers cannot keep sending through the socket that just closed. This
      // also leaves a logged-out account accurately marked as having no live
      // socket, while preserving the no-auto-reconnect loggedOut branch below.
      entry.sock = undefined;
      if (entry.ctx.sock === sock) entry.ctx.sock = undefined;
      const initialPairing = Boolean(
        !sock.authState?.creds?.registered
        && (entry.pairingPhoneNumber || config.pairingNumber),
      );
      if (initialPairing) {
        entry.pairingRetryAfterMs = Date.now() + config.pairingRetryCooldownMs;
        cachedPairingCodes.delete(folderPath);
        pairingReadySockets.delete(sock);
        rejectPendingPairing(
          folderPath,
          new PairingCodeError(
            "request_failed",
            "WhatsApp closed the initial pairing connection.",
            entry.pairingRetryAfterMs,
          ),
        );
        entry.pairingPhoneNumber = undefined;
        entry.pairingRequestedAtMs = undefined;
        // A 401 immediately after entering the code is WhatsApp rejecting the
        // unregistered companion session. The pairing request writes `me` and
        // `pairingCode` into creds before WhatsApp accepts it; retain those
        // files and the next attempt can inherit a stale half-paired session.
        // Clear only this tenant's auth files so a fresh code starts from a
        // genuinely unregistered state. Settings/history/media remain intact.
        if (statusCode === DisconnectReason.loggedOut) {
          clearAuthSession(authDir, folderPath);
        }
        const knownPairingFailure = [401, 408, 428, 429, 515].includes(
          statusCode ?? -1,
        );
        logger.error(
          {
            folderPath,
            statusCode: statusCode ?? "websocket_or_unknown",
            retryAfter: new Date(entry.pairingRetryAfterMs).toISOString(),
            knownPairingFailure,
          },
          "WhatsApp initial pairing failed; automatic retry disabled to avoid rate limiting. Restart manually to retry, or unset WA_PAIRING_NUMBER and restart for QR",
        );
      } else if (statusCode !== DisconnectReason.loggedOut) {
        // Rebuild only the socket; folder/DB/context setup is preserved.
        ensureSocketBuilt(entry, authDir, opts).catch((err) =>
          logger.error({ err, folderPath }, "reconnect failed"),
        );
      } else {
        // WhatsApp has invalidated this device session. Leaving creds.json in
        // place makes the next pairing request rebuild a socket with
        // `registered: true`, which is then rejected as "already linked" even
        // though the account is logged out. Clear only auth files so the next
        // socket starts with an unregistered auth state and can be paired with
        // the same phone number again.
        clearAuthSession(authDir, folderPath);
        logger.error(
          "Logged out from WhatsApp. Auth cleared; pair again from the control panel or QR.",
        );
      }
      return;
    }

    if (status === "open") {
      logger.info({ folderPath }, "WhatsApp socket connected");
      entry.pairingRetryAfterMs = undefined;
      entry.pairingPhoneNumber = undefined;
      entry.pairingRequestedAtMs = undefined;
      cachedPairingCodes.delete(folderPath);
      pairingReadySockets.delete(sock);
      rejectPendingPairing(
        folderPath,
        new PairingCodeError(
          "already_linked",
          "WhatsApp linked before another pairing code was needed.",
        ),
      );
      // Step 18: forward the normalized `whatsapp_status` exactly once.
      forwardStatus(entry, status);
      // Resolve configured owner phone numbers to their WhatsApp LIDs so
      // owner detection keeps working when group senders arrive as `@lid`.
      resolveOwnerLids(sock, entry.ctx.botOwnerJids || []).catch((err) =>
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
export function isStaleMessage(
  msg: WAMessage,
  nowMs: number = Date.now(),
): boolean {
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
        if (shouldIgnorePrivateChat(chatId)) continue;
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

        if (
          await handlePendingModelForm(
            account,
            sock,
            folderPath,
            chatId,
            senderId,
            text,
          )
        ) {
          continue;
        }
        if (!text || typeof text !== "string") continue;

        const slashCommand = parseSlashCommand(text);
        if (!slashCommand) continue;

        const isGroup = chatId.endsWith("@g.us");
        const chatType = isGroup ? "group" : "private";

        if (chatType === "private" && slashCommand.command !== "activate") {
          if (!isOwnerJid(senderId, account.botOwnerJids) && config.requireActivation && account.repos) {
            if (!account.repos.activation.isChatActivated(chatId)) continue;
          }
        }

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
          senderIsOwner: isOwnerJid(senderId, account.botOwnerJids),
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
    const liveMessages = messages.filter((msg) => {
      const chatId = msg?.key?.remoteJid;
      return !isStaleMessage(msg, nowMs)
        && (!chatId || !shouldIgnorePrivateChat(chatId));
    });
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
              // Check if the bot itself was added — catches cases where the
              // group-participants.update path fails (e.g. LID vs phone-JID).
              const normalizedParticipants = compactParticipantJids(
                stubEvent.participants,
              );
              const botAliases = new Set(currentBotAliases(account));
              let botBeingAdded = normalizedParticipants.some((p) =>
                botAliases.has(normalizeJid(p) || p),
              );
              // Fallback: direct JID comparison
              if (!botBeingAdded) {
                botBeingAdded = checkBotAddedDirect(
                  account,
                  normalizedParticipants,
                );
              }
              if (botBeingAdded) {
                await emitBotAddedEvent(account, {
                  chatId: stubEvent.chatId,
                  action: stubEvent.action,
                  participants: stubEvent.participants,
                  actorId: stubEvent.actorId,
                  timestampMs: stubEvent.timestampMs,
                  source: "messages.upsert.stub",
                });
                return;
              }
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
