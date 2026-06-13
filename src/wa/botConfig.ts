// Bot-wide owner-only configuration (stored in the bot_config table).
//
// Centralises the bot_config keys and the "effective value" accessors so the
// /bot-conf command (writer) and the activation gate (reader) agree on
// semantics. `require_activation` overrides the env default (config.requireActivation)
// at runtime; `activation_msg` overrides the built-in not-activated notice.

import config from "../config.js";
import type { AccountRepositories } from "../db/repositories/index.js";

export const BOT_CONFIG_KEYS = {
  ACTIVATION_MSG: "activation_msg",
  PROMPT_OVERRIDE: "prompt_override", // stored via setDefaultPrompt, mirrored here for display
  REQUIRE_ACTIVATION: "require_activation",
} as const;

export const DEFAULT_ACTIVATION_MESSAGE =
  "Bot ini belum diaktifkan untuk chat ini. Minta kode aktivasi ke owner, lalu kirim:\n/activate <kode>";

/** Resolve the activation notice text (owner override or the built-in default). */
export function getActivationMessage(repos: AccountRepositories): string {
  const custom = repos.settings.getBotConfig(BOT_CONFIG_KEYS.ACTIVATION_MSG);
  return custom && custom.trim() ? custom : DEFAULT_ACTIVATION_MESSAGE;
}

/**
 * Whether activation is required. The bot_config value (set via
 * `/bot-conf require-activation on|off`) overrides the env-derived default
 * (`config.requireActivation`); when unset, the env default applies.
 */
export function isActivationRequired(repos: AccountRepositories | undefined): boolean {
  const raw = repos?.settings.getBotConfig(BOT_CONFIG_KEYS.REQUIRE_ACTIVATION);
  if (raw === "on" || raw === "true" || raw === "1") return true;
  if (raw === "off" || raw === "false" || raw === "0") return false;
  return config.requireActivation;
}
