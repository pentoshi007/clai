import Conf from 'conf';
import type { Mode, ProviderId, ReasoningPreference } from '../types.js';
import { defaultModels } from '../llm/provider.js';

export interface ClaiConfig {
  defaultProvider: ProviderId;
  defaultModel: string;
  defaultMode: Mode;
  providerModels: Partial<Record<ProviderId, string>>;
  allowAlwaysTools: string[];
  pentestAuthorized: boolean;
  sandboxRoots: string[];
  ollamaHost: string;
  telemetry: boolean;
  autoUpdateCheck: boolean;
  freeOnly: boolean;
  lastUpdateCheck: number;
  thinking: ReasoningPreference;
}

const defaults: ClaiConfig = {
  defaultProvider: 'nvidia',
  defaultModel: defaultModels.nvidia,
  defaultMode: 'ask',
  providerModels: {},
  allowAlwaysTools: [],
  pentestAuthorized: false,
  sandboxRoots: [process.cwd()],
  ollamaHost: 'http://localhost:11434',
  telemetry: false,
  autoUpdateCheck: false,
  freeOnly: true,
  lastUpdateCheck: 0,
  thinking: { enabled: false, effort: 'medium' },
};

const store = new Conf<ClaiConfig>({
  projectName: 'clai',
  ...(process.env.CLAI_CONFIG_DIR ? { cwd: process.env.CLAI_CONFIG_DIR } : {}),
  defaults,
});

export function getConfig(): ClaiConfig {
  return store.store;
}

export function updateConfig(patch: Partial<ClaiConfig>): ClaiConfig {
  const next = { ...getConfig(), ...patch } satisfies ClaiConfig;
  store.store = next;
  return next;
}

export function setDefaultProvider(provider: ProviderId): ClaiConfig {
  const model = getProviderModel(provider);
  return updateConfig({ defaultProvider: provider, defaultModel: model });
}

export function setDefaultMode(mode: Mode): ClaiConfig {
  return updateConfig({ defaultMode: mode });
}

export function setProviderModel(provider: ProviderId, model: string): ClaiConfig {
  const current = getConfig();
  const providerModels = { ...current.providerModels, [provider]: model };
  return updateConfig({ providerModels, defaultModel: model });
}

export function getProviderModel(provider: ProviderId): string {
  const configured = getConfig().providerModels[provider];
  return configured ?? defaultModels[provider];
}

export function getConfigPath(): string {
  return store.path;
}

export function setThinking(patch: Partial<ReasoningPreference>): ClaiConfig {
  const current = getConfig().thinking;
  const next: ReasoningPreference = {
    enabled: patch.enabled ?? current.enabled,
    effort: patch.effort ?? current.effort,
  };
  return updateConfig({ thinking: next });
}
