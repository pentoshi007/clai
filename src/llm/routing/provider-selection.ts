import {
  getActiveProviderEndpoint,
  getCustomProviders,
  providerUsesEndpoints,
  resolveProviderCategory,
} from "../../store/config.js";
import { getProviderKeys, getProviderSecret } from "../../store/keys.js";
import type { ProviderId } from "../../types.js";
import { agentrouterProvider } from "../agentrouter.js";
import { anthropicProvider } from "../anthropic.js";
import { mantleProvider } from "../aws-mantle.js";
import { bynaraProvider } from "../bynara.js";
import { getCustomProviderSync } from "../custom-providers.js";
import { fireworksProvider } from "../fireworks.js";
import { freeProvider } from "../free.js";
import { geminiProvider } from "../gemini.js";
import { hetznerProvider } from "../hetzner.js";
import { lightningProvider } from "../lightning.js";
import { mergeGatewayProvider } from "../merge-gateway.js";
import { metaProvider } from "../meta.js";
import { modalProvider } from "../modal.js";
import { nvidiaProvider } from "../nvidia.js";
import { ollamaProvider } from "../ollama.js";
import { openaiProvider } from "../openai.js";
import { openrouterProvider } from "../openrouter.js";
import { orcarouterProvider } from "../orcarouter.js";
import type { LlmProvider, ProviderAuth } from "../provider.js";
import { qwenCloudProvider } from "../qwen-cloud.js";
import { tokenrouterProvider } from "../tokenrouter.js";

export const providers: Record<ProviderId, LlmProvider> = {
  free: freeProvider,
  gemini: geminiProvider,
  openrouter: openrouterProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
  nvidia: nvidiaProvider,
  agentrouter: agentrouterProvider,
  "aws-mantle": mantleProvider,
  ollama: ollamaProvider,
  bynara: bynaraProvider,
  "qwen-cloud": qwenCloudProvider,
  modal: modalProvider,
  lightning: lightningProvider,
  tokenrouter: tokenrouterProvider,
  meta: metaProvider,
  fireworks: fireworksProvider,
  hetzner: hetznerProvider,
  orcarouter: orcarouterProvider,
  "merge-gateway": mergeGatewayProvider,
};

const fallbackOrder: ProviderId[] = [
  "free",
  "nvidia",
  "gemini",
  "openrouter",
  "agentrouter",
  "bynara",
  "openai",
  "anthropic",
  "aws-mantle",
  "ollama",
  "qwen-cloud",
  "modal",
  "lightning",
  "tokenrouter",
  "meta",
  "fireworks",
  "hetzner",
  "orcarouter",
  "merge-gateway",
];

function allFallbackIds(): ProviderId[] {
  const custom = getCustomProviders().map((d) => d.id as ProviderId);
  return [...fallbackOrder, ...custom];
}

export async function requestedRealKeyCount(
  provider: ProviderId,
): Promise<number> {
  // Ollama's "key" is a local host URL, and `free` has no credential at all —
  if (provider === "ollama" || provider === "free") return 0;
  const multi = await getProviderKeys(provider);
  return multi.keys.filter((key) => key.value && !key.disabled).length;
}

export function buildFallbackChain(
  requested: ProviderId,
  freeOnly: boolean,
  enabled = false,
  preferAlternates = false,
): ProviderId[] {
  if (!enabled) return [requested];
  const order = allFallbackIds();
  const filtered = freeOnly
    ? order.filter(
        (provider) =>
          provider === requested ||
          resolveProviderCategory(provider) !== "paid-cloud",
      )
    : order;
  const alternates = filtered.filter((provider) => provider !== requested);
  return preferAlternates
    ? [...alternates, requested]
    : [requested, ...alternates];
}

export function getProvider(provider: ProviderId): LlmProvider {
  const builtin = providers[provider];
  if (builtin) return builtin;
  const custom = getCustomProviderSync(provider as string);
  if (custom) return custom;
  return providers.nvidia;
}

export async function providerAuth(
  provider: ProviderId,
): Promise<ProviderAuth> {
  const secret = await getProviderSecret(provider);
  if (provider === "ollama") {
    return { baseUrl: secret.value };
  }
  if (providerUsesEndpoints(provider)) {
    const baseUrl = getActiveProviderEndpoint(provider);
    return { apiKey: secret.value, ...(baseUrl ? { baseUrl } : {}) };
  }
  return { apiKey: secret.value };
}

export function authForSlot(
  providerId: ProviderId,
  value: string | undefined,
): ProviderAuth {
  if (providerId === "ollama") {
    return { baseUrl: value };
  }
  if (providerUsesEndpoints(providerId)) {
    const baseUrl = getActiveProviderEndpoint(providerId);
    return { apiKey: value, ...(baseUrl ? { baseUrl } : {}) };
  }
  return { apiKey: value };
}
