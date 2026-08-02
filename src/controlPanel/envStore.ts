import path from 'path';
import { randomUUID } from 'crypto';
import fs from 'fs-extra';
import { parse as parseDotenv } from 'dotenv';

export interface EnvironmentField {
  key: string;
  category: string;
  description: string;
  value: string;
  defaultValue: string;
  source: 'env_file' | 'process' | 'default';
  secret: boolean;
  configured: boolean;
  restartRequired: boolean;
}

export interface EnvironmentStoreOptions {
  envPath?: string;
  examplePath?: string;
}

export interface EnvironmentUpdate {
  values: Record<string, string>;
  clearSecrets?: string[];
}

const SECRET_KEY_RE = /(?:API_?KEY|TOKEN|SECRET|PASSWORD|COOKIE|PROXY_URL)$/i;
const RESTART_KEYS = new Set([
  'WS_LISTEN_PORT',
  'NODE_URL',
  'FOLDER_PATH',
  'FOLDER_PATHS',
  'ACCOUNTS_JSON',
  'ACCOUNTS_CONFIG',
  'INSTANCE_ID',
  'WA_PAIRING_NUMBER',
  'LLM_WS_TOKEN',
  'WS_BIND_HOST',
  'WS_MAX_PAYLOAD_BYTES',
  'DATA_DIR',
  'MEDIA_DIR',
  'STICKERS_DIR',
  'SETTINGS_DB_PATH',
  'STATS_DB_PATH',
  'MODERATION_DB_PATH',
  'SUBAGENT_DB_PATH',
  'BOT_SETTINGS_DB_PATH',
  'BOT_STATS_DB_PATH',
  'BOT_MODERATION_DB_PATH',
  'BOT_STICKERS_DB_PATH',
  'STICKERS_DB_PATH',
  'STICKER_UPLOAD_DIR',
  'WS_RECONNECT_MS',
  'WS_RECONNECT_MAX_MS',
  'WS_RECONNECT_JITTER_RATIO',
  'WS_HEARTBEAT_INTERVAL_MS',
  'BAILEYS_LOG_LEVEL',
  'HISTORY_LIMIT',
  'INCOMING_DEBOUNCE_SECONDS',
  'INCOMING_BURST_MAX_SECONDS',
  'PROMPT_MAX_CHARS',
  'REQUIRE_ACTIVATION',
  'SUBAGENT_WEBHOOK_PORT',
  'SUBAGENT_WEBHOOK_HOST',
  'DIRECT_INVOKE_PORT',
  'DIRECT_INVOKE_HOST',
  'CONTROL_PANEL_ENABLED',
  'CONTROL_PANEL_HOST',
  'CONTROL_PANEL_PORT',
  'CONTROL_PANEL_MAX_BODY_BYTES',
]);

function requiresRestart(key: string): boolean {
  return RESTART_KEYS.has(key)
    || /^(?:LLM1_|LLM2_|LLM_MEDIA_|LLM_REPLY_|SUBAGENT_|BRIDGE_|DIRECT_INVOKE_)/.test(key)
    || key === 'ASSISTANT_NAME';
}

function resolvedPaths(options: EnvironmentStoreOptions): {
  envPath: string;
  examplePath: string;
} {
  return {
    envPath: options.envPath || path.resolve(process.cwd(), '.env'),
    examplePath:
      options.examplePath || path.resolve(process.cwd(), '.env.example'),
  };
}

function categoryFor(key: string): string {
  if (key.startsWith('CONTROL_PANEL_')) return 'Control panel';
  if (key.startsWith('LLM1_')) return 'LLM1 router';
  if (key.startsWith('LLM2_') || key.startsWith('LLM_MEDIA_')) return 'LLM2 responder';
  if (key.startsWith('SUBAGENT_')) return 'Sub-agent';
  if (key.startsWith('BRIDGE_')) return 'Python bridge';
  if (key.startsWith('STICKER_') || key.includes('STICKERS')) return 'Stickers & media';
  if (key.startsWith('WS_') || key === 'NODE_URL' || key === 'LLM_WS_TOKEN') return 'Transport';
  if (key.includes('FOLDER_PATH') || key.includes('ACCOUNTS_') || key === 'DATA_DIR') return 'Accounts';
  if (key.includes('DB_') || key.endsWith('_DB_PATH')) return 'Database';
  if (
    key.startsWith('WA_')
    || key.startsWith('BOT_')
    || key.includes('ACTIVATION')
    || key === 'PRIVATE_CHAT_ENABLED'
    || key === 'ASSISTANT_NAME'
  ) return 'WhatsApp & bot';
  if (key.includes('LOG')) return 'Logging';
  return 'Advanced';
}

function schemaFromExample(exampleText: string): Map<
  string,
  { description: string; defaultValue: string; restartRequired: boolean }
> {
  const result = new Map<
    string,
    { description: string; defaultValue: string; restartRequired: boolean }
  >();
  let comments: string[] = [];
  for (const line of exampleText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      const comment = trimmed.replace(/^#+\s?/, '').trim();
      if (comment && !/^[-=]+$/.test(comment)) comments.push(comment);
      continue;
    }
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      if (!trimmed) comments = [];
      continue;
    }
    const key = match[1];
    const inlineRestart = match[2].includes('[restart]');
    const valueWithoutComment = match[2].replace(/\s+#.*$/, '').trim();
    if (!result.has(key)) {
      result.set(key, {
        description: comments.slice(-3).join(' '),
        defaultValue: valueWithoutComment,
        restartRequired: inlineRestart || requiresRestart(key),
      });
    }
    comments = [];
  }
  return result;
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

export async function readEnvironmentSettings(
  options: EnvironmentStoreOptions = {},
): Promise<EnvironmentField[]> {
  const { envPath, examplePath } = resolvedPaths(options);
  const [envText, exampleText] = await Promise.all([
    fs.pathExists(envPath).then((exists) =>
      exists ? fs.readFile(envPath, 'utf8') : '',
    ),
    fs.pathExists(examplePath).then((exists) =>
      exists ? fs.readFile(examplePath, 'utf8') : '',
    ),
  ]);
  const fileValues = parseDotenv(envText);
  const exampleValues = parseDotenv(exampleText);
  const schema = schemaFromExample(exampleText);
  for (const key of Object.keys(fileValues)) {
    if (!schema.has(key)) {
      schema.set(key, {
        description: 'Custom environment value.',
        defaultValue: '',
        restartRequired: requiresRestart(key),
      });
    }
  }

  return [...schema.entries()]
    .map(([key, meta]) => {
      const fromFile = Object.prototype.hasOwnProperty.call(fileValues, key);
      const fromProcess = !fromFile && process.env[key] !== undefined;
      const rawValue = fromFile
        ? fileValues[key]
        : fromProcess
          ? process.env[key] || ''
          : exampleValues[key] || '';
      const secret = isSecretKey(key);
      return {
        key,
        category: categoryFor(key),
        description: meta.description,
        value: secret ? '' : rawValue,
        defaultValue: secret ? '' : meta.defaultValue,
        source: fromFile ? 'env_file' : fromProcess ? 'process' : 'default',
        secret,
        configured: Boolean(rawValue),
        restartRequired: meta.restartRequired,
      } satisfies EnvironmentField;
    })
    .sort((a, b) =>
      a.category.localeCompare(b.category) || a.key.localeCompare(b.key),
    );
}

function serializeEnvValue(value: string): string {
  if (!value) return '';
  if (/^[A-Za-z0-9_./:@,+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

export async function updateEnvironmentSettings(
  update: EnvironmentUpdate,
  options: EnvironmentStoreOptions = {},
): Promise<{ changedKeys: string[]; restartRequiredKeys: string[] }> {
  const { envPath, examplePath } = resolvedPaths(options);
  const currentFields = await readEnvironmentSettings(options);
  const fieldByKey = new Map(currentFields.map((field) => [field.key, field]));
  const clearSecrets = new Set(update.clearSecrets || []);
  const values = new Map<string, string>();

  for (const [key, rawValue] of Object.entries(update.values || {})) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || !fieldByKey.has(key)) {
      throw new Error(`Unknown environment key: ${key}`);
    }
    if (typeof rawValue !== 'string' || rawValue.includes('\0')) {
      throw new Error(`Invalid value for ${key}`);
    }
    const field = fieldByKey.get(key)!;
    if (field.secret && !rawValue && !clearSecrets.has(key)) continue;
    values.set(key, rawValue);
  }
  for (const key of clearSecrets) {
    const field = fieldByKey.get(key);
    if (!field?.secret) throw new Error(`Not a secret environment key: ${key}`);
    values.set(key, '');
  }
  if (values.size === 0) return { changedKeys: [], restartRequiredKeys: [] };

  const exists = await fs.pathExists(envPath);
  const original = exists ? await fs.readFile(envPath, 'utf8') : '';
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const seen = new Set<string>();
  const output = original.split(/\r?\n/).map((line) => {
    const match = line.match(/^(\s*(?:export\s+)?)([A-Z][A-Z0-9_]*)(\s*=).*$/);
    if (!match || !values.has(match[2])) return line;
    seen.add(match[2]);
    return `${match[1]}${match[2]}${match[3]}${serializeEnvValue(values.get(match[2])!)}`;
  });
  const missing = [...values.keys()].filter((key) => !seen.has(key));
  if (missing.length) {
    if (output.length && output[output.length - 1] !== '') output.push('');
    output.push('# Added by WazzapAgents Control Panel');
    for (const key of missing) {
      output.push(`${key}=${serializeEnvValue(values.get(key)!)}`);
    }
  }

  await fs.ensureDir(path.dirname(envPath));
  const tempPath = `${envPath}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, output.join(newline), 'utf8');
  await fs.move(tempPath, envPath, { overwrite: true });

  // Touch the example only as a read dependency; this prevents an unused-path
  // lint false positive while keeping all writes strictly scoped to `.env`.
  void examplePath;
  const changedKeys = [...values.keys()].sort();
  return {
    changedKeys,
    restartRequiredKeys: changedKeys.filter(
      (key) => fieldByKey.get(key)?.restartRequired,
    ),
  };
}
