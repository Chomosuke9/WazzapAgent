// ---------------------------------------------------------------------------
// Auto-discovered button registry + dispatch
// ---------------------------------------------------------------------------
//
// Single source of truth for Node-side interactive button taps. Each button
// handler is a `ButtonHandler` descriptor (see `./ButtonContext.ts`) that
// declares the `selectedId` prefixes it owns plus an optional declarative
// permission / activation requirement. The registry builds one
// `Map<prefix, handler>` by scanning the SAME `../commands/` folder as
// `CommandRegistry` — both guards are mutually exclusive (`isCommandHandler`
// requires `commands`, `isButtonHandler` requires `prefixes`), so a command
// file can co-locate the button handler that renders its menu and both
// registries pick up the right exports.
//
// The repeated activation + owner/admin gate that every inline button handler
// used to re-implement is folded into ONE declarative gate enforced centrally
// here, via the shared, context-agnostic permission DSL in `./permission.ts`.

import { readdirSync } from "fs";
import { join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

import config from "../../config.js";
import logger from "../../logger.js";
import {
  PERMISSION_ATOMS,
  isPermitted,
  validatePermission,
  describePermission,
} from "./permission.js";
import type { ButtonContext, ButtonHandler } from "./ButtonContext.js";

/**
 * Prefix → handler map. Keyed by each handler's declared `selectedId` prefixes.
 *
 * Built once by {@link initButtonRegistry} via auto-discovery of the command
 * files in `../commands/`. Starts empty and is replaced wholesale by the init
 * function before the WS server starts; duplicate prefixes are a programming
 * error and throw during init.
 */
let buttonRegistry: Map<string, ButtonHandler> = new Map();

/**
 * Structural guard: an exported value that satisfies the ButtonHandler shape.
 * Intentionally disjoint from `isCommandHandler` (which keys on a `commands`
 * array, never present here) so both registries can scan the same folder.
 */
function isButtonHandler(val: unknown): val is ButtonHandler {
  const v = val as Record<string, unknown>;
  return (
    typeof val === "object" &&
    val !== null &&
    Array.isArray(v.prefixes) &&
    v.prefixes.length > 0 &&
    v.prefixes.every((p) => typeof p === "string") &&
    typeof v.run === "function"
  );
}

/** Resolve a canonical atom against a button tap's {@link ButtonContext}. */
function resolveButtonAtom(name: string, bc: ButtonContext): boolean {
  switch (PERMISSION_ATOMS[name.toLowerCase()]) {
    case "public":
      return true;
    case "owner":
      return bc.senderIsOwner;
    case "admin":
      return bc.senderIsAdmin;
    case "group":
      return bc.isGroup;
    case "private":
      return !bc.isGroup;
    case "from_me":
      // Button taps are user-originated, never the bot itself.
      return false;
    default:
      // Unknown atoms are rejected at init; treat defensively as deny here.
      return false;
  }
}

/**
 * Build a prefix → handler map from descriptors: validate each handler's
 * permission (default `"public"`) and reject duplicate prefixes. Pure (no fs /
 * module scope) so it is unit-testable; {@link initButtonRegistry} feeds it the
 * auto-discovered handlers.
 */
function buildButtonRegistry(
  handlers: ButtonHandler[],
): Map<string, ButtonHandler> {
  const map = new Map<string, ButtonHandler>();
  for (const handler of handlers) {
    const permission = handler.permission ?? "public";
    validatePermission(permission, handler.prefixes[0]);
    for (const prefix of handler.prefixes) {
      if (map.has(prefix)) {
        throw new Error(`Duplicate button prefix registered: ${prefix}`);
      }
      map.set(prefix, handler);
    }
  }
  return map;
}

/**
 * Auto-discover every `ButtonHandler` descriptor under `../commands/` and build
 * the prefix → handler registry. Co-located with the slash-command handlers:
 * the loop scans the same files and the same filter, collecting only exports
 * that satisfy {@link isButtonHandler}.
 *
 * Must be awaited once during boot (right after {@link
 * import('./CommandRegistry.js').initCommandRegistry}) so the registry is
 * populated before any dispatch can occur.
 */
async function initButtonRegistry(): Promise<void> {
  const commandDir = fileURLToPath(new URL("../commands/", import.meta.url));
  const files = readdirSync(commandDir).filter(
    (f) => f.endsWith(".ts") && f !== "index.ts" && f !== "parseCommand.ts",
  );
  const handlers: ButtonHandler[] = [];
  for (const file of files) {
    const fileUrl = pathToFileURL(join(commandDir, file)).href;
    const mod = await import(fileUrl);
    for (const val of Object.values(mod)) {
      if (isButtonHandler(val)) handlers.push(val);
    }
  }
  buttonRegistry = buildButtonRegistry(handlers);
}

/**
 * Resolve a `selectedId` to its handler using LONGEST-prefix match (so a more
 * specific prefix wins over a shorter one), returning the handler plus the
 * `selectedId` with the matched prefix stripped, or `null` when nothing owns
 * the id (e.g. `qz:` quiz replies, which fall through to the chatbot path).
 */
function findButtonHandler(
  selectedId: string,
): { handler: ButtonHandler; payload: string } | null {
  let best: { handler: ButtonHandler; payload: string } | null = null;
  let bestLen = -1;
  for (const [prefix, handler] of buttonRegistry) {
    if (selectedId.startsWith(prefix) && prefix.length > bestLen) {
      best = { handler, payload: selectedId.slice(prefix.length) };
      bestLen = prefix.length;
    }
  }
  return best;
}

/**
 * Dispatch a button tap. Resolves the owning handler, applies the declarative
 * activation + permission gates centrally, then runs the handler.
 *
 * @returns `true` when the tap was recognised and handled (caller suppresses
 *   normal message processing), `false` when no handler owns the id (so the
 *   caller lets it fall through — e.g. `qz:` quiz answers go to LLM2).
 */
async function dispatchButton(
  bc: ButtonContext,
  selectedId: string,
): Promise<boolean> {
  const match = findButtonHandler(selectedId);
  if (!match) return false;
  const { handler, payload } = match;

  // Activation gate (mirrors the old inline button handlers). Skipped for
  // handlers that opt out (`requireActivation: false`) because they delegate to
  // a path that performs its own activation gate.
  if (handler.requireActivation !== false) {
    if (
      config.requireActivation &&
      !bc.senderIsOwner &&
      !bc.account.repos!.activation.isChatActivated(bc.chatId)
    ) {
      return true;
    }
  }

  // Declarative permission gate. A recognised-but-denied tap is suppressed
  // (returns true) after a generic rejection reply, mirroring CommandRegistry.
  const permission = handler.permission ?? "public";
  if (!isPermitted(permission, (name) => resolveButtonAtom(name, bc))) {
    try {
      await bc.sock.sendMessage(bc.chatId, {
        text: `This action is only for ${describePermission(permission)}. ❌`,
      });
    } catch (e) {
      /* ignore */
    }
    return true;
  }

  try {
    await handler.run(bc, payload);
  } catch (err) {
    logger.error({ err }, "button response handler error");
  }
  return true;
}

/**
 * TEST SEAM — replace the prefix → handler map so tests can register stub
 * handlers without auto-discovery / a live socket. Pass a fresh `Map`.
 */
function __setButtonRegistryForTests(map: Map<string, ButtonHandler>): void {
  buttonRegistry = map;
}

export {
  initButtonRegistry,
  buildButtonRegistry,
  dispatchButton,
  findButtonHandler,
  isButtonHandler,
  buttonRegistry,
  __setButtonRegistryForTests,
};
