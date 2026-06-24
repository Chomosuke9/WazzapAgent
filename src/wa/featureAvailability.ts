// ---------------------------------------------------------------------------
// Feature availability (config gating)
// ---------------------------------------------------------------------------
//
// Some bot features only work once an operator sets the matching environment
// variables. Those features run on the Python bridge, but on a single-host
// deploy both processes load the same `.env`, so the Node gateway can read the
// same vars (see config.ts) to know whether a feature is configured.
//
// Rather than hide the corresponding options from `/setting` / `/help`, the
// command handlers consult this module and return a clear "not configured yet"
// error when the owner tries to use a feature whose setup is incomplete — so
// they learn exactly which variable to set instead of silently getting a
// setting that can never take effect.
//
// Adding a new gated feature is one entry in FEATURES plus a config flag.

import config from "../config.js";

/** Env-configured features that the settings UI / commands gate on. */
export type ConfigurableFeature = "llm1" | "subagent";

interface FeatureMeta {
  /** Whether the feature's required env is set (read from `config`). */
  configured: () => boolean;
  /** Owner-facing message shown when the feature is used while unconfigured. */
  unconfiguredMessage: string;
}

const FEATURES: Record<ConfigurableFeature, FeatureMeta> = {
  llm1: {
    configured: () => config.llm1Configured,
    unconfiguredMessage:
      "Auto and Hybrid modes need the LLM1 router, which isn't configured yet. " +
      "Set LLM1_ENDPOINT (plus LLM1_MODEL and LLM1_API_KEY) in your .env and " +
      "restart the bot. Prefix mode works without it.",
  },
  subagent: {
    configured: () => config.subagentConfigured,
    unconfiguredMessage:
      "The sub-agent isn't configured yet. Set SUBAGENT_URL in your .env and " +
      "restart the bot before enabling it.",
  },
};

/** Whether a configurable feature has its required env set. */
export function isFeatureConfigured(feature: ConfigurableFeature): boolean {
  return FEATURES[feature].configured();
}

/** Owner-facing "configure it first" message for a feature. */
export function unconfiguredFeatureMessage(feature: ConfigurableFeature): string {
  return FEATURES[feature].unconfiguredMessage;
}
