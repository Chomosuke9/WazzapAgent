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
  BOT_NAME: "bot_name",
  BOT_OWNER_JIDS: "bot_owner_jids",
  IDENTITY_SEEDED: "tenant_identity_seeded",
} as const;

export const DEFAULT_ACTIVATION_MESSAGE =
  "This bot hasn't been activated for this chat yet. Request an activation code from the owner, then send:\n/activate <code>";

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

/** Normalize the comma-separated owner syntax used by BOT_OWNER_JIDS. */
export function parseBotOwnerJids(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .map((value) => value.includes("@") ? value : `${value}@s.whatsapp.net`);
}

/** Import legacy process-wide identity settings into a tenant exactly once. */
export function seedTenantIdentity(repos: AccountRepositories): void {
  if (repos.settings.getBotConfig(BOT_CONFIG_KEYS.IDENTITY_SEEDED) !== null) return;
  if (!repos.settings.getBotConfig(BOT_CONFIG_KEYS.BOT_NAME) && config.assistantName !== "LLM") {
    repos.settings.setBotConfig(BOT_CONFIG_KEYS.BOT_NAME, config.assistantName);
  }
  if (!repos.settings.getBotConfig(BOT_CONFIG_KEYS.BOT_OWNER_JIDS) && config.botOwnerJids.length) {
    repos.settings.setBotConfig(
      BOT_CONFIG_KEYS.BOT_OWNER_JIDS,
      config.botOwnerJids.join(","),
    );
  }
  repos.settings.setBotConfig(BOT_CONFIG_KEYS.IDENTITY_SEEDED, "1");
}

export function getTenantBotName(repos: AccountRepositories): string {
  return repos.settings.getBotConfig(BOT_CONFIG_KEYS.BOT_NAME)?.trim()
    || config.assistantName;
}

export function getTenantBotOwnerJids(repos: AccountRepositories): string[] {
  const stored = repos.settings.getBotConfig(BOT_CONFIG_KEYS.BOT_OWNER_JIDS);
  return stored === null ? config.botOwnerJids.slice() : parseBotOwnerJids(stored);
}

export function isTenantLlm1Configured(repos: AccountRepositories): boolean {
  const provider = repos.settings.getLlmProviderConfig();
  return Boolean(provider?.llm1Endpoint || provider?.llm1FallbackEndpoint);
}

function envNullable(name: string): string | null {
  const value = process.env[name]?.trim();
  return value || null;
}

/** Copy the legacy shared LLM env values into a tenant once. */
export function seedTenantLlmProviderConfig(repos: AccountRepositories): void {
  if (repos.settings.getLlmProviderConfig() !== null) return;
  repos.settings.setLlmProviderConfig({
    llm1Model: envNullable("LLM1_MODEL"),
    llm1Endpoint: envNullable("LLM1_ENDPOINT"),
    llm1ApiKey: envNullable("LLM1_API_KEY") || envNullable("OPENAI_API_KEY"),
    llm1FallbackModel: envNullable("LLM1_FALLBACK_MODEL"),
    llm1FallbackEndpoint: envNullable("LLM1_FALLBACK_ENDPOINT"),
    llm1FallbackApiKey: envNullable("LLM1_FALLBACK_API_KEY"),
    llm2Model: envNullable("LLM2_MODEL"),
    llm2Endpoint: envNullable("LLM2_ENDPOINT"),
    llm2ApiKey: envNullable("LLM2_API_KEY"),
    llm2FallbackModel: envNullable("LLM2_FALLBACK_MODEL"),
    llm2FallbackEndpoint: envNullable("LLM2_FALLBACK_ENDPOINT"),
    llm2FallbackApiKey: envNullable("LLM2_FALLBACK_API_KEY"),
  });
}
