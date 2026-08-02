import http from 'http';
import type { IncomingMessage, Server, ServerResponse } from 'http';
import path from 'path';
import { createHash, timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import config, { reloadConfigFromEnv } from '../config.js';
import logger from '../logger.js';
import * as registry from '../server/accountRegistry.js';
import type { AccountEntry } from '../protocol/types.js';
import {
  disconnectAccount,
  ensureFolderLayout,
  openAccountPersistence,
  PairingCodeError,
  reconnectAccount,
  requestAccountPairingCode,
} from '../account/baileysFactory.js';
import {
  BOT_CONFIG_KEYS,
  DEFAULT_ACTIVATION_MESSAGE,
  isActivationRequired,
} from '../wa/botConfig.js';
import {
  deleteSticker,
  GLOBAL_STICKER_CHAT_ID,
  listStickers,
  STICKER_NAME_RE,
  upsertLottieSticker,
  upsertWebpSticker,
} from '../wa/commands/stickerStore.js';
import {
  VALID_COMPAT_MODES,
  VALID_MODES,
  VALID_TRIGGERS,
} from '../db/repositories/SettingsRepository.js';
import {
  readEnvironmentSettings,
  updateEnvironmentSettings,
} from './envStore.js';
import type { EnvironmentStoreOptions } from './envStore.js';
import { ControlPanelAuditLog } from './auditLog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTH_WINDOW_MS = 60_000;
const AUTH_MAX_FAILURES = 10;

interface AuthFailureState {
  count: number;
  windowStartedAt: number;
}

export interface ControlPanelServerOptions extends EnvironmentStoreOptions {
  tokenProvider?: () => string | null;
  publicDir?: string;
  auditPath?: string;
  maxBodyBytes?: number;
}

interface ErrorDetail {
  code?: string;
  retryAfterMs?: number;
  [key: string]: unknown;
}

class HttpError extends Error {
  readonly status: number;
  readonly detail?: ErrorDetail;

  constructor(status: number, message: string, detail?: ErrorDetail) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.detail = detail;
  }
}

function sendSecurityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
}

function json(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown> | unknown[],
): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
}

function tokenIsConfigured(token: string | null): token is string {
  return Boolean(token?.trim());
}

function publicStickers(folderPath: string): Array<Record<string, unknown>> {
  return listStickers(folderPath).map(({ filePath: _filePath, ...sticker }) => sticker);
}

function secureTokenEquals(expectedToken: string, header: string | undefined): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const expected = Buffer.from(`Bearer ${expectedToken}`);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function readJsonBody<T>(
  req: IncomingMessage,
  maxBytes: number,
): Promise<T> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const rawChunk of req) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    size += chunk.length;
    if (size > maxBytes) {
      throw new HttpError(413, 'Request body is too large.');
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

function encodeOpaqueId(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeOpaqueId(value: string): string {
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    throw new HttpError(400, 'Invalid identifier.');
  }
}

export function accountControlPanelId(folderPath: string): string {
  return encodeOpaqueId(folderPath);
}

function ensureAccountPersistence(entry: AccountEntry): void {
  if (entry.repos) return;
  const layout = ensureFolderLayout(entry.folderPath);
  openAccountPersistence(entry, layout.dbDir);
  if (entry.ctx) entry.ctx.repos = entry.repos;
}

function accountFromId(id: string): AccountEntry {
  const folderPath = decodeOpaqueId(id);
  const entry = registry.get(folderPath);
  if (!entry) throw new HttpError(404, 'Account not found.');
  ensureAccountPersistence(entry);
  return entry;
}

function displayFolderPath(folderPath: string): string {
  const relative = path.relative(process.cwd(), path.resolve(folderPath));
  return relative && !relative.startsWith('..') ? relative : folderPath;
}

function accountPhone(entry: AccountEntry): string | null {
  const jid = entry.sock?.user?.id || entry.sock?.authState?.creds?.me?.id;
  if (!jid) return null;
  return jid.split('@')[0].split(':')[0] || null;
}

function accountSummary(entry: AccountEntry): Record<string, unknown> {
  ensureAccountPersistence(entry);
  const id = accountControlPanelId(entry.folderPath);
  const configuredName = entry.repos?.settings.getBotConfig(
    'control_panel_account_name',
  );
  const isDefault = path.resolve(entry.folderPath) === path.resolve(config.dataDir);
  const registered = Boolean(entry.sock?.authState?.creds?.registered);
  return {
    id,
    name:
      configuredName?.trim()
      || (isDefault ? 'Primary account' : path.basename(entry.folderPath)),
    folderPath: displayFolderPath(entry.folderPath),
    waStatus: entry.waStatus,
    registered,
    linked: registered && entry.waStatus === 'open',
    phoneNumber: accountPhone(entry),
    bridgeConnected: entry.client?.readyState === 1,
    queueSize: entry.reliableQueue.length,
    pairingInProgress: Boolean(entry.pairingPhoneNumber),
    pairingRequestedAtMs: entry.pairingRequestedAtMs || null,
    pairingRetryAfterMs: entry.pairingRetryAfterMs || null,
    caches: {
      messages: entry.ctx?.messageCache?.size || 0,
      chats: entry.ctx?.senderRefRegistryByChat?.size || 0,
      groups: entry.ctx?.groupMetadataCache?.size || 0,
    },
  };
}

function normalizeChatId(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'chatId is required.');
  const chatId = value.trim();
  if (!chatId || chatId.length > 256 || /[\u0000-\u001f]/.test(chatId)) {
    throw new HttpError(400, 'Invalid chatId.');
  }
  return chatId;
}

function nullableString(value: unknown, maxLength: number, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new HttpError(400, `${field} must be at most ${maxLength} characters.`);
  }
  return value;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new HttpError(400, `${field} must be boolean.`);
  return value;
}

function integerValue(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, `${field} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function optionalIdle(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  return integerValue(value, field, 1, 100_000);
}

function chatSettingsResponse(entry: AccountEntry, chatId: string): Record<string, unknown> {
  const repos = entry.repos!;
  const own = repos.settings.getChatSettingsRecord(chatId);
  const effective = repos.settings.getEffectiveChatSettings(chatId);
  return {
    chatId,
    exists: Boolean(own),
    source: own ? 'chat' : 'default',
    settings: effective,
    memories: repos.settings.listMemories(chatId),
    capabilities: {
      llm1Configured: config.llm1Configured,
      subagentConfigured: config.subagentConfigured,
    },
  };
}

function invalidateChatSettings(entry: AccountEntry, chatId: string): void {
  registry.sendReliableToClient(entry.folderPath, {
    type: 'invalidate_chat_settings',
    folderPath: entry.folderPath,
    chatId: chatId === '__global__' ? 'global' : chatId,
  });
}

function updateChatSettings(
  entry: AccountEntry,
  chatId: string,
  body: Record<string, unknown>,
): void {
  const repos = entry.repos!;
  const before = repos.settings.getEffectiveChatSettings(chatId);
  const promptLimit = Math.max(1, Number(process.env.PROMPT_MAX_CHARS) || 4000);

  if ('prompt' in body) {
    repos.settings.setPrompt(
      chatId,
      nullableString(body.prompt, promptLimit, 'prompt'),
    );
  }
  if ('permission' in body) {
    repos.settings.setPermission(
      chatId,
      integerValue(body.permission, 'permission', 0, 3),
    );
  }
  if ('mode' in body) {
    if (typeof body.mode !== 'string' || !VALID_MODES.has(body.mode)) {
      throw new HttpError(400, 'mode must be auto, prefix, or hybrid.');
    }
    if (
      body.mode !== before?.mode
      && (body.mode === 'auto' || body.mode === 'hybrid')
      && !config.llm1Configured
    ) {
      throw new HttpError(409, 'LLM1 must be configured before using auto or hybrid mode.');
    }
    repos.settings.setMode(chatId, body.mode);
  }
  if ('compatibilityMode' in body) {
    if (
      typeof body.compatibilityMode !== 'string'
      || !VALID_COMPAT_MODES.has(body.compatibilityMode)
    ) {
      throw new HttpError(400, 'Invalid compatibility mode.');
    }
    repos.settings.setCompatibilityMode(chatId, body.compatibilityMode);
  }
  if ('triggers' in body) {
    if (!Array.isArray(body.triggers)) throw new HttpError(400, 'triggers must be an array.');
    const triggers = body.triggers.map(String);
    if (triggers.some((trigger) => !VALID_TRIGGERS.has(trigger))) {
      throw new HttpError(400, 'One or more triggers are invalid.');
    }
    repos.settings.setTriggers(chatId, triggers);
  }
  if ('subagentEnabled' in body) {
    const enabled = booleanValue(body.subagentEnabled, 'subagentEnabled');
    if (enabled && !before?.subagentEnabled && !config.subagentConfigured) {
      throw new HttpError(409, 'Configure SUBAGENT_URL before enabling the sub-agent.');
    }
    repos.settings.setSubagentEnabled(chatId, enabled);
  }
  if ('announcementEnabled' in body) {
    repos.settings.setAnnouncementEnabled(
      chatId,
      booleanValue(body.announcementEnabled, 'announcementEnabled'),
    );
  }
  if ('idleTriggerMin' in body || 'idleTriggerMax' in body) {
    const min = optionalIdle(body.idleTriggerMin, 'idleTriggerMin');
    const max = optionalIdle(body.idleTriggerMax, 'idleTriggerMax');
    if (min !== null && max !== null && min > max) {
      throw new HttpError(400, 'idleTriggerMin cannot exceed idleTriggerMax.');
    }
    repos.settings.setIdleTrigger(chatId, min, min === null ? null : max ?? min);
  }
  if ('llm2Model' in body) {
    const modelId = nullableString(body.llm2Model, 200, 'llm2Model');
    if (modelId && !repos.model.getAllModels().some((model) => model.modelId === modelId)) {
      throw new HttpError(400, 'The selected model does not exist in this tenant.');
    }
    repos.model.setLlm2Model(chatId, modelId);
    registry.sendReliableToClient(entry.folderPath, {
      type: 'set_llm2_model',
      folderPath: entry.folderPath,
      chatId,
      modelId,
    });
    registry.sendReliableToClient(entry.folderPath, {
      type: 'invalidate_llm2_model',
      folderPath: entry.folderPath,
      chatId,
    });
  }

  invalidateChatSettings(entry, chatId);
  const after = repos.settings.getEffectiveChatSettings(chatId);
  if (before?.subagentEnabled !== after?.subagentEnabled && after) {
    registry.sendReliableToClient(entry.folderPath, {
      type: 'set_subagent_enabled',
      folderPath: entry.folderPath,
      chatId: chatId === '__global__' ? 'global' : chatId,
      enabled: after.subagentEnabled,
    });
  }
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function safeModelId(raw: string): string {
  const id = decodeURIComponent(raw).trim();
  if (!id || id.length > 200 || /[\u0000-\u001f]/.test(id)) {
    throw new HttpError(400, 'Invalid model id.');
  }
  return id;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected control panel error.';
}

async function serveStatic(
  pathname: string,
  publicDir: string,
  res: ServerResponse,
): Promise<boolean> {
  const asset = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'app.js', 'styles.css'].includes(asset)) return false;
  const filePath = path.join(publicDir, asset);
  if (!(await fs.pathExists(filePath))) throw new HttpError(404, 'Asset not found.');
  const body = await fs.readFile(filePath);
  const mime = asset.endsWith('.js')
    ? 'text/javascript; charset=utf-8'
    : asset.endsWith('.css')
      ? 'text/css; charset=utf-8'
      : 'text/html; charset=utf-8';
  res.statusCode = 200;
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', body.length);
  res.end(body);
  return true;
}

export function createControlPanelServer(
  options: ControlPanelServerOptions = {},
): Server {
  const publicDir = options.publicDir || path.join(__dirname, 'public');
  const maxBodyBytes = options.maxBodyBytes || config.controlPanelMaxBodyBytes;
  const tokenProvider = options.tokenProvider || (() => config.controlPanelToken);
  const audit = new ControlPanelAuditLog(
    options.auditPath || path.join(config.dataDir, 'control-panel-audit.jsonl'),
  );
  const authFailures = new Map<string, AuthFailureState>();

  const server = http.createServer(async (req, res) => {
    sendSecurityHeaders(res);
    const method = req.method || 'GET';
    const requestUrl = new URL(req.url || '/', 'http://control-panel.local');
    const pathname = requestUrl.pathname;

    try {
      if (method === 'GET' && !pathname.startsWith('/api/')) {
        if (await serveStatic(pathname, publicDir, res)) return;
      }

      if (method === 'GET' && pathname === '/api/auth/status') {
        const token = tokenProvider();
        json(res, 200, {
          configured: tokenIsConfigured(token),
          tokenRequired: true,
          host: config.controlPanelHost,
          port: config.controlPanelPort,
        });
        return;
      }

      if (!pathname.startsWith('/api/')) throw new HttpError(404, 'Not found.');

      const token = tokenProvider();
      if (!tokenIsConfigured(token)) {
        throw new HttpError(
          503,
          'Set CONTROL_PANEL_TOKEN to a non-empty value before using the API.',
          { code: 'setup_required' },
        );
      }
      const remoteAddress = req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const failure = authFailures.get(remoteAddress);
      if (
        failure
        && now - failure.windowStartedAt < AUTH_WINDOW_MS
        && failure.count >= AUTH_MAX_FAILURES
      ) {
        throw new HttpError(429, 'Too many failed authentication attempts.');
      }
      const header = typeof req.headers.authorization === 'string'
        ? req.headers.authorization
        : undefined;
      if (!secureTokenEquals(token, header)) {
        const current = authFailures.get(remoteAddress);
        authFailures.set(remoteAddress, {
          count:
            current && now - current.windowStartedAt < AUTH_WINDOW_MS
              ? current.count + 1
              : 1,
          windowStartedAt:
            current && now - current.windowStartedAt < AUTH_WINDOW_MS
              ? current.windowStartedAt
              : now,
        });
        throw new HttpError(401, 'Invalid admin token.');
      }
      authFailures.delete(remoteAddress);

      if (method === 'GET' && pathname === '/api/overview') {
        const entries = registry.list();
        for (const entry of entries) ensureAccountPersistence(entry);
        const accounts = entries.map(accountSummary);
        const defaultEntry = entries.find(
          (entry) => path.resolve(entry.folderPath) === path.resolve(config.dataDir),
        ) || entries[0];
        json(res, 200, {
          instanceId: config.instanceId,
          generatedAt: new Date().toISOString(),
          health: {
            nodeGateway: 'online',
            pythonConnected: accounts.filter((account) => account.bridgeConnected).length,
            pythonTotal: accounts.length,
            whatsappLinked: accounts.filter((account) => account.linked).length,
            whatsappTotal: accounts.length,
            queuedEvents: entries.reduce(
              (total, entry) => total + entry.reliableQueue.length,
              0,
            ),
          },
          runtime: {
            llm2Model: process.env.LLM2_MODEL || 'Not configured',
            requireActivation: defaultEntry
              ? isActivationRequired(defaultEntry.repos)
              : config.requireActivation,
            privateChatEnabled: config.privateChatEnabled,
            subagentDefault: config.subagentEnabledDefault,
            llm1Configured: config.llm1Configured,
            subagentConfigured: config.subagentConfigured,
          },
          accounts,
          recentActivity: audit.list(8),
        });
        return;
      }

      if (method === 'GET' && pathname === '/api/accounts') {
        json(res, 200, { accounts: registry.list().map(accountSummary) });
        return;
      }

      const accountAction = pathname.match(
        /^\/api\/accounts\/([^/]+)\/(pairing-code|reconnect|session)$/,
      );
      if (accountAction) {
        const accountId = accountAction[1];
        const action = accountAction[2];
        const entry = accountFromId(accountId);
        if (method === 'POST' && action === 'pairing-code') {
          const body = await readJsonBody<{ phoneNumber?: unknown }>(req, maxBodyBytes);
          if (typeof body.phoneNumber !== 'string') {
            throw new HttpError(400, 'phoneNumber is required.');
          }
          try {
            const result = await requestAccountPairingCode(
              entry.folderPath,
              body.phoneNumber,
            );
            audit.record('pairing_code_generated', 'Generated a native WhatsApp pairing code.', {
              accountId,
            });
            json(res, 200, result as unknown as Record<string, unknown>);
          } catch (error) {
            audit.record('pairing_code_failed', errorMessage(error), {
              accountId,
              outcome: 'failure',
            });
            if (error instanceof PairingCodeError) {
              throw new HttpError(
                error.code === 'invalid_phone' ? 400 : 409,
                error.message,
                { code: error.code, retryAfterMs: error.retryAfterMs },
              );
            }
            throw error;
          }
          return;
        }
        if (method === 'POST' && action === 'reconnect') {
          await reconnectAccount(entry.folderPath);
          audit.record('account_reconnected', 'Rebuilt the WhatsApp socket.', { accountId });
          json(res, 202, { ok: true });
          return;
        }
        if (method === 'DELETE' && action === 'session') {
          const body = await readJsonBody<{ confirm?: unknown }>(req, maxBodyBytes);
          if (body.confirm !== 'DISCONNECT') {
            throw new HttpError(400, 'Type DISCONNECT to confirm session removal.');
          }
          await disconnectAccount(entry.folderPath);
          audit.record('account_disconnected', 'Removed the WhatsApp auth session.', {
            accountId,
          });
          json(res, 200, { ok: true });
          return;
        }
        throw new HttpError(405, 'Method not allowed.');
      }

      const accountRoot = pathname.match(/^\/api\/accounts\/([^/]+)$/);
      if (accountRoot && method === 'PUT') {
        const accountId = accountRoot[1];
        const entry = accountFromId(accountId);
        const body = await readJsonBody<{ name?: unknown }>(req, maxBodyBytes);
        const name = nullableString(body.name, 80, 'name');
        entry.repos!.settings.setBotConfig('control_panel_account_name', name);
        audit.record('account_updated', 'Updated the control panel account name.', {
          accountId,
        });
        json(res, 200, accountSummary(entry));
        return;
      }

      const chatSettingsRoute = pathname.match(
        /^\/api\/accounts\/([^/]+)\/chat-settings(?:\/detail)?$/,
      );
      if (chatSettingsRoute) {
        const accountId = chatSettingsRoute[1];
        const entry = accountFromId(accountId);
        if (method === 'GET' && pathname.endsWith('/chat-settings')) {
          json(res, 200, {
            chats: entry.repos!.settings.listChatSettings(),
            models: entry.repos!.model.getAllModels(),
          });
          return;
        }
        if (method === 'GET') {
          const chatId = normalizeChatId(requestUrl.searchParams.get('chatId'));
          json(res, 200, chatSettingsResponse(entry, chatId));
          return;
        }
        if (method === 'PUT') {
          const body = await readJsonBody<Record<string, unknown>>(req, maxBodyBytes);
          const chatId = normalizeChatId(body.chatId);
          updateChatSettings(entry, chatId, body);
          audit.record('chat_settings_updated', `Updated settings for ${chatId}.`, {
            accountId,
          });
          json(res, 200, chatSettingsResponse(entry, chatId));
          return;
        }
        if (method === 'DELETE') {
          const body = await readJsonBody<Record<string, unknown>>(req, maxBodyBytes);
          const chatId = normalizeChatId(body.chatId);
          if (chatId === '__global__') {
            throw new HttpError(400, 'The default settings row cannot be deleted.');
          }
          entry.repos!.settings.clearSettings(chatId);
          invalidateChatSettings(entry, chatId);
          audit.record('chat_settings_reset', `Reset settings for ${chatId}.`, {
            accountId,
          });
          json(res, 200, chatSettingsResponse(entry, chatId));
          return;
        }
      }

      const memoriesRoute = pathname.match(/^\/api\/accounts\/([^/]+)\/memories$/);
      if (memoriesRoute) {
        const accountId = memoriesRoute[1];
        const entry = accountFromId(accountId);
        if (method === 'GET') {
          const scope = normalizeChatId(requestUrl.searchParams.get('scope'));
          json(res, 200, { scope, memories: entry.repos!.settings.listMemories(scope) });
          return;
        }
        const body = await readJsonBody<Record<string, unknown>>(req, maxBodyBytes);
        const scope = normalizeChatId(body.scope);
        if (method === 'POST') {
          const text = nullableString(body.text, 4000, 'text');
          if (!text) throw new HttpError(400, 'Memory text is required.');
          entry.repos!.settings.addMemory(scope, text);
          invalidateChatSettings(entry, scope);
          audit.record('memory_added', `Added memory for ${scope}.`, { accountId });
          json(res, 201, { memories: entry.repos!.settings.listMemories(scope) });
          return;
        }
        if (method === 'DELETE') {
          const index = integerValue(body.index, 'index', 1, 1_000_000);
          const deleted = entry.repos!.settings.deleteMemoryByIndex(scope, index);
          if (deleted === null) throw new HttpError(404, 'Memory entry not found.');
          invalidateChatSettings(entry, scope);
          audit.record('memory_deleted', `Deleted memory ${index} for ${scope}.`, {
            accountId,
          });
          json(res, 200, { memories: entry.repos!.settings.listMemories(scope) });
          return;
        }
      }

      const modelsRoot = pathname.match(/^\/api\/accounts\/([^/]+)\/models$/);
      if (modelsRoot) {
        const accountId = modelsRoot[1];
        const entry = accountFromId(accountId);
        if (method === 'GET') {
          json(res, 200, { models: entry.repos!.model.getAllModels() });
          return;
        }
        if (method === 'POST') {
          const body = await readJsonBody<Record<string, unknown>>(req, maxBodyBytes);
          const modelId = nullableString(body.modelId, 200, 'modelId');
          const displayName = nullableString(body.displayName, 120, 'displayName');
          if (!modelId || !displayName) {
            throw new HttpError(400, 'modelId and displayName are required.');
          }
          const added = entry.repos!.model.addModel(
            modelId,
            displayName,
            nullableString(body.description, 500, 'description') || '',
            body.sortOrder === null || body.sortOrder === undefined
              ? null
              : integerValue(body.sortOrder, 'sortOrder', -100_000, 100_000),
            body.visionSupport === undefined
              ? false
              : booleanValue(body.visionSupport, 'visionSupport'),
          );
          if (!added) throw new HttpError(409, 'A model with this id already exists.');
          registry.sendReliableToClient(entry.folderPath, {
            type: 'invalidate_default_model',
            folderPath: entry.folderPath,
          });
          audit.record('model_added', `Added model ${modelId}.`, { accountId });
          json(res, 201, { models: entry.repos!.model.getAllModels() });
          return;
        }
      }

      const modelAction = pathname.match(
        /^\/api\/accounts\/([^/]+)\/models\/([^/]+)(?:\/(default))?$/,
      );
      if (modelAction) {
        const accountId = modelAction[1];
        const entry = accountFromId(accountId);
        const modelId = safeModelId(modelAction[2]);
        if (method === 'POST' && modelAction[3] === 'default') {
          const models = entry.repos!.model.getAllModels();
          const model = models.find((item) => item.modelId === modelId);
          if (!model) throw new HttpError(404, 'Model not found.');
          const minOrder = models.length
            ? Math.min(...models.map((item) => item.sortOrder))
            : 0;
          entry.repos!.model.updateModel(modelId, {
            sortOrder: minOrder - 1,
            isActive: true,
          });
          registry.sendReliableToClient(entry.folderPath, {
            type: 'invalidate_default_model',
            folderPath: entry.folderPath,
          });
          audit.record('default_model_updated', `Set ${modelId} as default.`, {
            accountId,
          });
          json(res, 200, { models: entry.repos!.model.getAllModels() });
          return;
        }
        if (method === 'PUT') {
          const body = await readJsonBody<Record<string, unknown>>(req, maxBodyBytes);
          const success = entry.repos!.model.updateModel(modelId, {
            displayName:
              body.displayName === undefined
                ? undefined
                : nullableString(body.displayName, 120, 'displayName') || '',
            description:
              body.description === undefined
                ? undefined
                : nullableString(body.description, 500, 'description') || '',
            isActive:
              body.isActive === undefined
                ? undefined
                : booleanValue(body.isActive, 'isActive'),
            sortOrder:
              body.sortOrder === undefined
                ? undefined
                : integerValue(body.sortOrder, 'sortOrder', -100_000, 100_000),
            visionSupport:
              body.visionSupport === undefined
                ? undefined
                : booleanValue(body.visionSupport, 'visionSupport'),
          });
          if (!success) throw new HttpError(404, 'Model not found.');
          registry.sendReliableToClient(entry.folderPath, {
            type: 'invalidate_default_model',
            folderPath: entry.folderPath,
          });
          audit.record('model_updated', `Updated model ${modelId}.`, { accountId });
          json(res, 200, { models: entry.repos!.model.getAllModels() });
          return;
        }
        if (method === 'DELETE') {
          const result = entry.repos!.model.deleteModel(modelId);
          if (!result.success) throw new HttpError(404, 'Model not found.');
          registry.sendReliableToClient(entry.folderPath, {
            type: 'invalidate_default_model',
            folderPath: entry.folderPath,
          });
          for (const chatId of result.affectedChatIds) {
            registry.sendReliableToClient(entry.folderPath, {
              type: 'set_llm2_model',
              folderPath: entry.folderPath,
              chatId,
              modelId: null,
            });
            registry.sendReliableToClient(entry.folderPath, {
              type: 'invalidate_llm2_model',
              folderPath: entry.folderPath,
              chatId,
            });
          }
          audit.record('model_deleted', `Deleted model ${modelId}.`, { accountId });
          json(res, 200, { models: entry.repos!.model.getAllModels() });
          return;
        }
      }

      const activationRoot = pathname.match(
        /^\/api\/accounts\/([^/]+)\/activation$/,
      );
      if (activationRoot && method === 'GET') {
        const entry = accountFromId(activationRoot[1]);
        json(res, 200, {
          codes: entry.repos!.activation.getAllActivationCodes(),
          activations: entry.repos!.activation.getAllActivations(),
          required: isActivationRequired(entry.repos),
        });
        return;
      }

      const activationCodes = pathname.match(
        /^\/api\/accounts\/([^/]+)\/activation-codes(?:\/(\d+))?$/,
      );
      if (activationCodes) {
        const accountId = activationCodes[1];
        const entry = accountFromId(accountId);
        if (method === 'POST' && !activationCodes[2]) {
          const body = await readJsonBody<Record<string, unknown>>(req, maxBodyBytes);
          if (typeof body.type !== 'string' || !['private', 'group', 'all'].includes(body.type)) {
            throw new HttpError(400, 'type must be private, group, or all.');
          }
          const days = integerValue(body.days ?? 0, 'days', 0, 3650);
          const generated = entry.repos!.activation.generateActivationCode(
            body.type,
            days,
            'control-panel',
          );
          audit.record('activation_code_generated', `Generated a ${body.type} activation code.`, {
            accountId,
          });
          json(res, 201, { code: generated, codes: entry.repos!.activation.getAllActivationCodes() });
          return;
        }
        if (method === 'DELETE' && activationCodes[2]) {
          const id = Number(activationCodes[2]);
          const result = entry.repos!.activation.revokeActivationCode(id);
          if (!result.success) throw new HttpError(404, result.message);
          audit.record('activation_code_revoked', `Revoked activation code ${id}.`, {
            accountId,
          });
          json(res, 200, {
            result,
            codes: entry.repos!.activation.getAllActivationCodes(),
            activations: entry.repos!.activation.getAllActivations(),
          });
          return;
        }
      }

      const botConfigRoute = pathname.match(
        /^\/api\/accounts\/([^/]+)\/bot-config$/,
      );
      if (botConfigRoute) {
        const accountId = botConfigRoute[1];
        const entry = accountFromId(accountId);
        const repos = entry.repos!;
        if (method === 'GET') {
          json(res, 200, {
            requireActivation: isActivationRequired(repos),
            activationMessage:
              repos.settings.getBotConfig(BOT_CONFIG_KEYS.ACTIVATION_MSG)
              || DEFAULT_ACTIVATION_MESSAGE,
            defaultPrompt: repos.settings.getPrompt('__global__'),
            joinPrompt: repos.settings.getBotConfig('join_prompt'),
            ownerContact: repos.settings.getOwnerContact(),
            accountName: repos.settings.getBotConfig('control_panel_account_name'),
            raw: repos.settings.listBotConfig(),
          });
          return;
        }
        if (method === 'PUT') {
          const body = await readJsonBody<Record<string, unknown>>(req, maxBodyBytes);
          if ('requireActivation' in body) {
            repos.settings.setBotConfig(
              BOT_CONFIG_KEYS.REQUIRE_ACTIVATION,
              booleanValue(body.requireActivation, 'requireActivation') ? 'on' : 'off',
            );
          }
          if ('activationMessage' in body) {
            repos.settings.setBotConfig(
              BOT_CONFIG_KEYS.ACTIVATION_MSG,
              nullableString(body.activationMessage, 4000, 'activationMessage'),
            );
          }
          if ('defaultPrompt' in body) {
            repos.settings.setDefaultPrompt(
              nullableString(body.defaultPrompt, 4000, 'defaultPrompt'),
            );
          }
          if ('joinPrompt' in body) {
            repos.settings.setBotConfig(
              'join_prompt',
              nullableString(body.joinPrompt, 4000, 'joinPrompt'),
            );
          }
          if ('accountName' in body) {
            repos.settings.setBotConfig(
              'control_panel_account_name',
              nullableString(body.accountName, 80, 'accountName'),
            );
          }
          if ('ownerContact' in body) {
            const contact = body.ownerContact as Record<string, unknown> | null;
            if (!contact || typeof contact !== 'object') {
              throw new HttpError(400, 'ownerContact must be an object.');
            }
            const phoneNumber = nullableString(contact.phoneNumber, 40, 'phoneNumber');
            const displayName = nullableString(contact.displayName, 120, 'displayName');
            if (!phoneNumber || !displayName) {
              throw new HttpError(400, 'Owner phone number and display name are required.');
            }
            repos.settings.setOwnerContact(phoneNumber, displayName);
          }
          invalidateChatSettings(entry, '__global__');
          audit.record('bot_config_updated', 'Updated tenant-wide bot configuration.', {
            accountId,
          });
          json(res, 200, { ok: true });
          return;
        }
      }

      const stickersRoute = pathname.match(/^\/api\/accounts\/([^/]+)\/stickers$/);
      if (stickersRoute) {
        const accountId = stickersRoute[1];
        const entry = accountFromId(accountId);
        if (method === 'GET') {
          json(res, 200, {
            stickers: publicStickers(entry.folderPath),
          });
          return;
        }
        if (method === 'POST') {
          const body = await readJsonBody<Record<string, unknown>>(req, maxBodyBytes);
          const chatId = normalizeChatId(body.chatId || GLOBAL_STICKER_CHAT_ID);
          const name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
          if (!STICKER_NAME_RE.test(name)) {
            throw new HttpError(400, 'Sticker name must use a-z, 0-9, underscore, or dash.');
          }
          if (body.kind === 'lottie') {
            if (typeof body.lottiePayload !== 'string' || !body.lottiePayload.trim()) {
              throw new HttpError(400, 'lottiePayload is required.');
            }
            try {
              JSON.parse(body.lottiePayload);
            } catch {
              throw new HttpError(400, 'lottiePayload must be valid JSON.');
            }
            upsertLottieSticker(
              entry.folderPath,
              chatId,
              name,
              body.lottiePayload,
              'control-panel',
            );
          } else if (body.kind === 'webp') {
            if (typeof body.dataBase64 !== 'string') {
              throw new HttpError(400, 'dataBase64 is required.');
            }
            const base64 = body.dataBase64.replace(/^data:[^;]+;base64,/, '');
            const bytes = Buffer.from(base64, 'base64');
            if (!bytes.length || bytes.length > config.stickerMaxSizeKb * 1024) {
              throw new HttpError(
                400,
                `Sticker must be at most ${config.stickerMaxSizeKb} KiB.`,
              );
            }
            if (
              bytes.subarray(0, 4).toString('ascii') !== 'RIFF'
              || bytes.subarray(8, 12).toString('ascii') !== 'WEBP'
            ) {
              throw new HttpError(400, 'Uploaded sticker must be a WebP file.');
            }
            const uploadDir = entry.ctx.stickerUploadDir
              || path.join(entry.folderPath, 'stickers_user');
            await fs.ensureDir(uploadDir);
            const chatHash = createHash('sha256').update(chatId).digest('hex').slice(0, 10);
            const filePath = path.join(uploadDir, `${chatHash}_${name}.webp`);
            await fs.writeFile(filePath, bytes);
            upsertWebpSticker(
              entry.folderPath,
              chatId,
              name,
              filePath,
              'control-panel',
            );
          } else {
            throw new HttpError(400, 'kind must be webp or lottie.');
          }
          audit.record('sticker_saved', `Saved sticker ${name} for ${chatId}.`, {
            accountId,
          });
          json(res, 201, { stickers: publicStickers(entry.folderPath) });
          return;
        }
        if (method === 'DELETE') {
          const body = await readJsonBody<Record<string, unknown>>(req, maxBodyBytes);
          const chatId = normalizeChatId(body.chatId);
          const name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
          if (!STICKER_NAME_RE.test(name)) throw new HttpError(400, 'Invalid sticker name.');
          const existing = listStickers(entry.folderPath).find(
            (sticker) => sticker.chatId === chatId && sticker.name === name,
          );
          if (!deleteSticker(entry.folderPath, chatId, name)) {
            throw new HttpError(404, 'Sticker not found.');
          }
          if (existing?.filePath) {
            const uploadDir = entry.ctx.stickerUploadDir
              || path.join(entry.folderPath, 'stickers_user');
            if (isPathInside(uploadDir, existing.filePath)) {
              await fs.remove(existing.filePath).catch(() => undefined);
            }
          }
          audit.record('sticker_deleted', `Deleted sticker ${name} for ${chatId}.`, {
            accountId,
          });
          json(res, 200, { stickers: publicStickers(entry.folderPath) });
          return;
        }
      }

      if (pathname === '/api/system/environment') {
        if (method === 'GET') {
          json(res, 200, {
            fields: await readEnvironmentSettings(options),
          });
          return;
        }
        if (method === 'PUT') {
          const body = await readJsonBody<{
            values?: Record<string, string>;
            clearSecrets?: string[];
          }>(req, maxBodyBytes);
          const requestedHost = body.values?.CONTROL_PANEL_HOST;
          if (
            typeof requestedHost === 'string'
            && requestedHost.trim()
            && (
              requestedHost.trim().length > 255
              || !/^[A-Za-z0-9._:%-]+$/.test(requestedHost.trim())
            )
          ) {
            throw new HttpError(400, 'CONTROL_PANEL_HOST must be an IP address or hostname.');
          }
          const requestedPort = body.values?.CONTROL_PANEL_PORT;
          if (typeof requestedPort === 'string' && requestedPort.trim()) {
            const port = Number(requestedPort);
            if (!/^\d+$/.test(requestedPort.trim()) || port < 1 || port > 65535) {
              throw new HttpError(400, 'CONTROL_PANEL_PORT must be between 1 and 65535.');
            }
          }
          const result = await updateEnvironmentSettings(
            {
              values: body.values || {},
              clearSecrets: body.clearSecrets || [],
            },
            options,
          );
          // The production server uses the repository-root `.env`. Reload it
          // synchronously so token rotations take effect before this response
          // reaches the browser; fs.watch remains the fallback for outside edits.
          if (!options.envPath) reloadConfigFromEnv();
          audit.record(
            'environment_updated',
            `Updated environment keys: ${result.changedKeys.join(', ') || 'none'}.`,
          );
          json(res, 200, {
            ...result,
            fields: await readEnvironmentSettings(options),
          });
          return;
        }
      }

      if (method === 'GET' && pathname === '/api/logs') {
        const limit = Number(requestUrl.searchParams.get('limit') || 100);
        json(res, 200, { entries: audit.list(limit) });
        return;
      }

      throw new HttpError(404, 'API endpoint not found.');
    } catch (error) {
      if (res.writableEnded) return;
      const httpError = error instanceof HttpError
        ? error
        : new HttpError(500, errorMessage(error));
      if (httpError.status >= 500 && httpError.detail?.code !== 'setup_required') {
        logger.error({ err: error, method, pathname }, 'control panel request failed');
      }
      json(res, httpError.status, {
        error: httpError.message,
        ...(httpError.detail || {}),
      });
    }
  });

  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  return server;
}

export function startControlPanel(): Server {
  const server = createControlPanelServer();
  server.on('listening', () => {
    const address = server.address();
    const port = typeof address === 'object' && address
      ? address.port
      : config.controlPanelPort;
    logger.info(
      {
        host: config.controlPanelHost,
        port,
        configured: tokenIsConfigured(config.controlPanelToken),
      },
      'control panel listening',
    );
    if (!tokenIsConfigured(config.controlPanelToken)) {
      logger.warn(
        'Control panel is in setup-only mode. Set CONTROL_PANEL_TOKEN to a non-empty value.',
      );
    }
  });
  server.on('error', (error) => {
    logger.error({ err: error }, 'control panel server error');
  });
  server.listen(config.controlPanelPort, config.controlPanelHost);
  return server;
}
