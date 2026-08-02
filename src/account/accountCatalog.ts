import path from 'path';
import { randomUUID } from 'crypto';
import fs from 'fs-extra';
import { parse as parseDotenv } from 'dotenv';

export const MANAGED_ACCOUNTS_MARKER = 'wazzapagents-control-panel';
export const ACCOUNT_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export interface ConfiguredAccount {
  folderPath: string;
  configPath: string;
  nodeUrl: string;
  slot: number;
}

export type AccountCatalogSource =
  | 'accounts_json'
  | 'managed_file'
  | 'folder_paths'
  | 'fallback';

export interface AccountCatalogSnapshot {
  accounts: ConfiguredAccount[];
  source: AccountCatalogSource;
  sourcePath: string | null;
  managed: boolean;
}

export interface AccountCatalogOptions {
  rootDir?: string;
  envPath?: string;
  managedPath?: string;
  environment?: NodeJS.ProcessEnv;
}

export interface AddAccountInput {
  accountKey: string;
  nodeUrl?: string | null;
}

export class AccountCatalogError extends Error {
  readonly code: 'invalid_account' | 'duplicate_account' | 'account_not_found' | 'last_account';

  constructor(
    code: AccountCatalogError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'AccountCatalogError';
    this.code = code;
  }
}

interface RawAccount {
  folder_path?: unknown;
  folderPath?: unknown;
  node_url?: unknown;
  nodeUrl?: unknown;
  slot?: unknown;
}

interface ParsedCatalogFile {
  accounts: unknown[];
  nodeUrl: string;
  managed: boolean;
}

function validateNodeUrl(value: string): string {
  const cleaned = value.trim();
  if (!/^wss?:\/\//i.test(cleaned)) {
    throw new Error('node_url must start with ws:// or wss://.');
  }
  return cleaned;
}

function normalizedFolderPath(rootDir: string, value: string): string {
  return path.resolve(rootDir, value.trim());
}

function portableConfigPath(rootDir: string, folderPath: string): string {
  const relative = path.relative(rootDir, folderPath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return `./${relative.split(path.sep).join('/')}`;
  }
  return folderPath;
}

function allocateSlot(used: Set<number>): number {
  for (let slot = 0; slot <= 999; slot += 1) {
    if (!used.has(slot)) return slot;
  }
  throw new Error('No free account runtime slots remain.');
}

function parseSlot(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 999) {
    throw new Error('Account slot must be an integer between 0 and 999.');
  }
  return Number(value);
}

function parseCatalogFile(raw: unknown, sharedNodeUrl: string): ParsedCatalogFile {
  if (Array.isArray(raw)) {
    return { accounts: raw, nodeUrl: sharedNodeUrl, managed: false };
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error("Accounts config must be a list or an object with an 'accounts' key.");
  }
  const object = raw as Record<string, unknown>;
  if (!Array.isArray(object.accounts)) {
    throw new Error("Accounts config object must contain an 'accounts' list.");
  }
  const nodeUrl = typeof object.node_url === 'string'
    ? validateNodeUrl(object.node_url)
    : sharedNodeUrl;
  return {
    accounts: object.accounts,
    nodeUrl,
    managed: object.managed_by === MANAGED_ACCOUNTS_MARKER,
  };
}

function normalizeAccounts(
  rawAccounts: unknown[],
  rootDir: string,
  sharedNodeUrl: string,
): ConfiguredAccount[] {
  const pending: Array<Omit<ConfiguredAccount, 'slot'> & { slot: number | null }> = [];
  const seenPaths = new Set<string>();
  const usedSlots = new Set<number>();

  for (const item of rawAccounts) {
    const raw = typeof item === 'string' ? { folder_path: item } : item as RawAccount;
    if (!raw || typeof raw !== 'object') throw new Error('Invalid account entry.');
    const folderValue = raw.folder_path ?? raw.folderPath;
    if (typeof folderValue !== 'string' || !folderValue.trim()) {
      throw new Error('Account entry is missing folder_path.');
    }
    const folderPath = normalizedFolderPath(rootDir, folderValue);
    const pathKey = process.platform === 'win32' ? folderPath.toLowerCase() : folderPath;
    if (seenPaths.has(pathKey)) throw new Error(`Duplicate account folder_path: ${folderValue}`);
    seenPaths.add(pathKey);

    const rawNodeUrl = raw.node_url ?? raw.nodeUrl;
    const nodeUrl = typeof rawNodeUrl === 'string'
      ? validateNodeUrl(rawNodeUrl)
      : sharedNodeUrl;
    const slot = parseSlot(raw.slot);
    if (slot !== null) {
      if (usedSlots.has(slot)) throw new Error(`Duplicate account slot: ${slot}`);
      usedSlots.add(slot);
    }
    pending.push({
      folderPath,
      configPath: folderValue.trim(),
      nodeUrl,
      slot,
    });
  }

  return pending.map((account) => {
    const slot = account.slot ?? allocateSlot(usedSlots);
    usedSlots.add(slot);
    return { ...account, slot };
  });
}

export class AccountCatalog {
  readonly rootDir: string;
  readonly envPath: string;
  readonly managedPath: string;
  private readonly environment: NodeJS.ProcessEnv;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: AccountCatalogOptions = {}) {
    this.rootDir = path.resolve(options.rootDir || process.cwd());
    this.envPath = path.resolve(options.envPath || path.join(this.rootDir, '.env'));
    this.managedPath = path.resolve(
      options.managedPath || path.join(this.rootDir, 'accounts.json'),
    );
    this.environment = options.environment || process.env;
  }

  private async envValues(): Promise<Record<string, string>> {
    const fileValues = await fs.pathExists(this.envPath)
      ? parseDotenv(await fs.readFile(this.envPath, 'utf8'))
      : {};
    return new Proxy(fileValues, {
      get: (target, key: string) => this.environment[key] ?? target[key],
    });
  }

  private async readJson(filePath: string): Promise<unknown> {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Accounts config not found: ${filePath}`);
      }
      throw error;
    }
  }

  async read(): Promise<AccountCatalogSnapshot> {
    const env = await this.envValues();
    const sharedNodeUrl = validateNodeUrl(env.NODE_URL || 'ws://localhost:3000');
    const explicit = (env.ACCOUNTS_JSON || env.ACCOUNTS_CONFIG || '').trim();
    if (explicit) {
      const sourcePath = path.resolve(this.rootDir, explicit);
      const parsed = parseCatalogFile(await this.readJson(sourcePath), sharedNodeUrl);
      const accounts = normalizeAccounts(parsed.accounts, this.rootDir, parsed.nodeUrl);
      if (accounts.length) {
        return { accounts, source: 'accounts_json', sourcePath, managed: parsed.managed };
      }
    }

    if (await fs.pathExists(this.managedPath)) {
      const parsed = parseCatalogFile(await this.readJson(this.managedPath), sharedNodeUrl);
      if (parsed.managed) {
        const accounts = normalizeAccounts(parsed.accounts, this.rootDir, parsed.nodeUrl);
        if (accounts.length) {
          return {
            accounts,
            source: 'managed_file',
            sourcePath: this.managedPath,
            managed: true,
          };
        }
      }
    }

    const folderPaths = (env.FOLDER_PATHS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (folderPaths.length) {
      return {
        accounts: normalizeAccounts(folderPaths, this.rootDir, sharedNodeUrl),
        source: 'folder_paths',
        sourcePath: null,
        managed: false,
      };
    }

    const fallback = (env.FOLDER_PATH || env.DATA_DIR || './data').trim();
    return {
      accounts: normalizeAccounts([fallback], this.rootDir, sharedNodeUrl),
      source: 'fallback',
      sourcePath: null,
      managed: false,
    };
  }

  private async write(accounts: ConfiguredAccount[]): Promise<AccountCatalogSnapshot> {
    const current = await this.read();
    const sourcePath = current.source === 'accounts_json' && current.sourcePath
      ? current.sourcePath
      : this.managedPath;
    const sharedNodeUrl = accounts[0]?.nodeUrl || 'ws://localhost:3000';
    const body = {
      managed_by: MANAGED_ACCOUNTS_MARKER,
      node_url: sharedNodeUrl,
      accounts: accounts.map((account) => ({
        folder_path: portableConfigPath(this.rootDir, account.folderPath),
        ...(account.nodeUrl !== sharedNodeUrl ? { node_url: account.nodeUrl } : {}),
        slot: account.slot,
      })),
    };
    await fs.ensureDir(path.dirname(sourcePath));
    const tempPath = `${sourcePath}.${randomUUID()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    await fs.move(tempPath, sourcePath, { overwrite: true });
    return this.read();
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  add(input: AddAccountInput): Promise<{ account: ConfiguredAccount; snapshot: AccountCatalogSnapshot }> {
    return this.mutate(async () => {
      const accountKey = input.accountKey.trim().toLowerCase();
      if (!ACCOUNT_KEY_RE.test(accountKey)) {
        throw new AccountCatalogError(
          'invalid_account',
          'Account ID must use 1-48 lowercase letters, numbers, _ or -.',
        );
      }
      const snapshot = await this.read();
      const tenantRoot = path.resolve(this.rootDir, 'tenants');
      const folderPath = path.resolve(tenantRoot, accountKey);
      const relative = path.relative(tenantRoot, folderPath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Account folder must stay inside the tenants directory.');
      }
      if (snapshot.accounts.some((account) => account.folderPath === folderPath)) {
        throw new AccountCatalogError('duplicate_account', 'An account with this ID already exists.');
      }
      const used = new Set(snapshot.accounts.map((account) => account.slot));
      const account: ConfiguredAccount = {
        folderPath,
        configPath: portableConfigPath(this.rootDir, folderPath),
        nodeUrl: input.nodeUrl ? validateNodeUrl(input.nodeUrl) : snapshot.accounts[0].nodeUrl,
        slot: allocateSlot(used),
      };
      const next = await this.write([...snapshot.accounts, account]);
      return {
        account: next.accounts.find((item) => item.folderPath === folderPath)!,
        snapshot: next,
      };
    });
  }

  remove(folderPath: string): Promise<{ removed: ConfiguredAccount; snapshot: AccountCatalogSnapshot }> {
    return this.mutate(async () => {
      const snapshot = await this.read();
      const normalized = path.resolve(folderPath);
      const removed = snapshot.accounts.find((account) => account.folderPath === normalized);
      if (!removed) {
        throw new AccountCatalogError(
          'account_not_found',
          'Account is not present in the configured catalog.',
        );
      }
      if (snapshot.accounts.length <= 1) {
        throw new AccountCatalogError('last_account', 'At least one account must remain configured.');
      }
      const next = await this.write(
        snapshot.accounts.filter((account) => account.folderPath !== normalized),
      );
      return { removed, snapshot: next };
    });
  }
}

export async function loadConfiguredAccounts(
  options: AccountCatalogOptions = {},
): Promise<AccountCatalogSnapshot> {
  return new AccountCatalog(options).read();
}
