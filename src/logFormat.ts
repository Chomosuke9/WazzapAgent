/**
 * logFormat.ts — pure, dependency-free pretty formatter for pino records.
 *
 * Turns a parsed pino log object into a single clean line that mirrors the
 * Python bridge's format so both processes look consistent in a terminal:
 *
 *     HH:MM:SS LVL [scope] message  key=val key2="val with space"
 *
 * - `LVL` is a fixed-width 3-char tag (TRC/DBG/INF/WRN/ERR/FTL), colorized.
 * - `[scope]` is the tenant `folderPath` (or an explicit `scope` binding such
 *   as the tamed Baileys child logger); omitted when absent.
 * - structured fields render as compact `key=value` pairs instead of a JSON
 *   blob; objects/arrays are JSON-encoded and truncated.
 * - an `err` field renders as `err=Type: message` inline, with the stack
 *   indented + dimmed on error/fatal only (kept off the line otherwise).
 *
 * This module performs NO I/O and reads NO env — it is a pure function so it is
 * trivially unit-testable and reusable. Color is decided by the caller.
 */

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const COLORS = {
  gray: '\x1b[90m',
  red: '\x1b[31m',
  brightRed: '\x1b[91m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

interface LevelStyle {
  tag: string;
  color: string;
}

// pino numeric levels → fixed-width 3-char tag + color.
const LEVELS: Record<number, LevelStyle> = {
  10: { tag: 'TRC', color: COLORS.gray },
  20: { tag: 'DBG', color: COLORS.cyan },
  30: { tag: 'INF', color: COLORS.green },
  40: { tag: 'WRN', color: COLORS.yellow },
  50: { tag: 'ERR', color: COLORS.red },
  60: { tag: 'FTL', color: COLORS.brightRed },
};

// Keys that are structural (rendered specially or intentionally hidden) and so
// must never appear in the trailing `key=val` field list.
const RESERVED = new Set([
  'level',
  'time',
  'msg',
  'instanceId',
  'pid',
  'hostname',
  'name',
  'scope',
  'folderPath',
  'class',
  'err',
  'v',
]);

// Per-value cap so one fat object can't blow up a log line.
const MAX_VALUE_CHARS = 240;

export interface FormatOptions {
  color: boolean;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatTime(time: unknown): string {
  const date = typeof time === 'number' ? new Date(time) : new Date();
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function paint(text: string, color: string, on: boolean): string {
  return on && color ? `${color}${text}${RESET}` : text;
}

function needsQuote(s: string): boolean {
  return s === '' || /[\s"=]/.test(s);
}

/** Render an arbitrary structured value as a compact, length-capped token. */
function renderValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const t = typeof value;
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(value);
  if (t === 'string') {
    const s = value as string;
    return needsQuote(s) ? JSON.stringify(s) : s;
  }
  let s: string;
  try {
    s = JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s === undefined) s = String(value);
  if (s.length > MAX_VALUE_CHARS) {
    s = `${s.slice(0, MAX_VALUE_CHARS)}…(+${s.length - MAX_VALUE_CHARS})`;
  }
  return s;
}

interface ErrLike {
  type?: unknown;
  message?: unknown;
  stack?: unknown;
}

/** Build the inline error head + (optional) indented stack for error/fatal. */
function renderError(
  err: unknown,
  level: number,
  color: boolean,
): { head: string; stack: string } {
  if (typeof err === 'string') {
    return { head: paint(`err=${renderValue(err)}`, COLORS.red, color), stack: '' };
  }
  if (!err || typeof err !== 'object') return { head: '', stack: '' };
  const e = err as ErrLike;
  const type = typeof e.type === 'string' && e.type ? e.type : 'Error';
  const message = typeof e.message === 'string' ? e.message : '';
  const headText = `err=${type}${message ? `: ${message}` : ''}`;
  const head = paint(headText, COLORS.red, color);
  let stack = '';
  if (level >= 50 && typeof e.stack === 'string') {
    const lines = e.stack
      .split('\n')
      .slice(1)
      .map((line) => `    ${line.trim()}`)
      .filter((line) => line.trim().length > 0);
    if (lines.length) stack = paint(lines.join('\n'), DIM, color);
  }
  return { head, stack };
}

/**
 * Format a single parsed pino record into a clean, optionally-colorized line.
 * Pure: same input + options always yields the same string.
 */
export function formatRecord(record: Record<string, unknown>, opts: FormatOptions): string {
  const color = opts.color;
  const levelNum = typeof record.level === 'number' ? record.level : 30;
  const style = LEVELS[levelNum] ?? { tag: String(record.level ?? '???'), color: '' };

  const time = paint(formatTime(record.time), DIM, color);
  const level = paint(style.tag, style.color, color);

  const scopeRaw =
    (typeof record.scope === 'string' && record.scope) ||
    (typeof record.folderPath === 'string' && record.folderPath) ||
    '';
  const scope = scopeRaw ? ` ${paint(`[${scopeRaw}]`, DIM, color)}` : '';

  const msg =
    typeof record.msg === 'string' ? record.msg : record.msg != null ? String(record.msg) : '';

  // Trailing key=val fields (everything not structural).
  const fields: string[] = [];
  if (
    typeof record.instanceId === 'string' &&
    record.instanceId &&
    record.instanceId !== 'default'
  ) {
    fields.push(`inst=${renderValue(record.instanceId)}`);
  }
  for (const key of Object.keys(record)) {
    if (RESERVED.has(key)) continue;
    fields.push(`${key}=${renderValue(record[key])}`);
  }
  const tail = fields.length ? `  ${paint(fields.join(' '), DIM, color)}` : '';

  const { head: errHead, stack: errStack } = renderError(record.err, levelNum, color);
  const errInline = errHead ? `  ${errHead}` : '';

  const line = `${time} ${level}${scope} ${msg}${errInline}${tail}`;
  return errStack ? `${line}\n${errStack}` : line;
}
