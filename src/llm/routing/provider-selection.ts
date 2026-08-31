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

/**
 * Built-in provider ids in fallback preference order. Custom (user-defined)
 * provider ids are appended after the built-ins so they participate in the
 * cross-provider fallback chain when enabled, in config declaration order.
 */
function allFallbackIds(): ProviderId[] {
  const custom = getCustomProviders().map((d) => d.id as ProviderId);
  return [...fallbackOrder, ...custom];
}

export async function requestedRealKeyCount(
  provider: ProviderId,
): Promise<number> {
  // Ollama's "key" is a local host URL, and `free` has no credential at all —
  // both are keyless/local slots, not a single real API key. Counting them
  // here would disable fallback for the two providers that most need it when
  // the local server or free tier is unavailable.
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
  // A live-connection stall has already spent one full generation on the
  // selected route. Retrying it first creates the duplicate partial bubbles in
  // the reported failure. Try configured alternates first for that recovery
  // attempt, but retain the user's selected provider as the final fallback.
  return preferAlternates
    ? [...alternates, requested]
    : [requested, ...alternates];
}

export function getProvider(provider: ProviderId): LlmProvider {
  const builtin = providers[provider];
  if (builtin) return builtin;
  // Custom (user-defined) providers are not in the static map; resolve them
  // from the runtime registry. Returns undefined for an unknown id.
  const custom = getCustomProviderSync(provider as string);
  if (custom) return custom;
  // Unknown id: return the first built-in so callers that don't pre-validate
  // get a usable object rather than `undefined`. Callers that need to assert
  // existence use `assertProvider` (which now accepts custom ids too).
  return providers.nvidia;
}

export async function providerAuth(
  provider: ProviderId,
): Promise<ProviderAuth> {
  const secret = await getProviderSecret(provider);
  if (provider === "ollama") {
    return { baseUrl: secret.value };
  }
  // Endpoint providers carry both: the stored secret plus the active endpoint
  // URL from config (Modal requires one; Lightning treats it as an override).
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
