// Per-account repository bundle (Step 05).
//
// `AccountEntry` owns one {@link Database} for its tenant and one repository
// instance per domain built from it. This barrel groups the four step-04
// repositories into a single `AccountRepositories` bundle and provides
// {@link createRepositories} so the account factory can construct them in one
// call. No SQL/behavior lives here — only composition.

import type { Database } from "../Database.js";
import { SettingsRepository } from "./SettingsRepository.js";
import { StatsRepository } from "./StatsRepository.js";
import { ModelRepository } from "./ModelRepository.js";
import { ActivationRepository } from "./ActivationRepository.js";

/**
 * The full set of per-account repositories, each bound to the same tenant
 * {@link Database}. Threaded to consumers via `AccountContext.repos` (wa/*) and
 * `CommandContext.repos` (command handlers).
 */
export interface AccountRepositories {
  settings: SettingsRepository;
  stats: StatsRepository;
  model: ModelRepository;
  activation: ActivationRepository;
}

/**
 * Build the four domain repositories against a single tenant {@link Database}.
 * The caller (`baileysFactory`/`index.ts`) opens the `Database` first, then
 * passes it here so every repository shares that tenant's connections.
 */
export function createRepositories(db: Database): AccountRepositories {
  return {
    settings: new SettingsRepository(db),
    stats: new StatsRepository(db),
    model: new ModelRepository(db),
    activation: new ActivationRepository(db),
  };
}

export {
  SettingsRepository,
  VALID_MODES,
  VALID_TRIGGERS,
} from "./SettingsRepository.js";
export { StatsRepository } from "./StatsRepository.js";
export { ModelRepository } from "./ModelRepository.js";
export { ActivationRepository } from "./ActivationRepository.js";
