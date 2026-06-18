/**
 * logger.ts — application logger.
 *
 * pino remains the logging engine (levels, `child`, `{obj}, msg` API), but its
 * default single-line JSON output is replaced with a clean, human-readable,
 * color-aware line via a custom destination stream that parses each serialized
 * record and re-renders it through {@link formatRecord} (see logFormat.ts).
 *
 * `baileysLogger` is a child logger handed to `makeWASocket` so Baileys' very
 * chatty internal logging (which otherwise defaults to its own raw-JSON `info`
 * logger) is both level-tamed (default `warn`) and rendered in the SAME clean
 * format as the rest of the gateway, tagged `[baileys]`.
 */
import { pino } from 'pino';
import { Writable } from 'node:stream';
import config from './config.js';
import { formatRecord } from './logFormat.js';

/** Decide whether to emit ANSI color: explicit LOG_COLOR wins, then NO_COLOR,
 *  then TTY auto-detection. Mirrors the Python bridge so both agree. */
function resolveColor(): boolean {
  const mode = (config.logColor || 'auto').toLowerCase();
  if (['1', 'true', 'always', 'yes', 'on'].includes(mode)) return true;
  if (['0', 'false', 'never', 'no', 'off'].includes(mode)) return false;
  // NO_COLOR convention: any non-empty value disables color.
  if (process.env.NO_COLOR != null && process.env.NO_COLOR !== '') return false;
  return Boolean(process.stdout.isTTY);
}

const useColor = resolveColor();

// Custom destination: pino writes one serialized JSON record (+ newline) per
// log; we parse and pretty-print it. A small carry buffer keeps a record that
// is split across two writes from being mangled, and any line that fails to
// parse is passed through verbatim so nothing is ever silently dropped.
let carry = '';
const prettyDestination = new Writable({
  write(chunk: Buffer | string, _encoding, callback) {
    carry += chunk.toString();
    let newlineIndex = carry.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = carry.slice(0, newlineIndex);
      carry = carry.slice(newlineIndex + 1);
      if (line) {
        try {
          process.stdout.write(`${formatRecord(JSON.parse(line), { color: useColor })}\n`);
        } catch {
          process.stdout.write(`${line}\n`);
        }
      }
      newlineIndex = carry.indexOf('\n');
    }
    callback();
  },
});

const logger: pino.Logger = pino(
  {
    level: config.logLevel,
    base: { instanceId: config.instanceId },
  },
  prettyDestination,
);

/**
 * Tamed Baileys logger: a child tagged `scope: 'baileys'` so its output renders
 * as `[baileys]` through the shared formatter, with its own level (default
 * `warn`) so Baileys' default `info` connection/keys chatter is suppressed
 * while genuine warnings/errors still surface cleanly.
 */
export const baileysLogger: pino.Logger = logger.child({ scope: 'baileys' });
baileysLogger.level = config.baileysLogLevel;

export default logger;
