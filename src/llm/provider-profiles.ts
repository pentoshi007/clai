import type { ProviderId } from "../types.js";
import {
  applyObservedControlRejections,
  resolveProviderProfile,
  type ProviderProfile,
  type ProviderProfileLayer,
  type ProviderProfileSourceLayers,
  type WireApi,
} from "./provider-profile.js";
import { providerContextOverrideTokens } from "./token-usage.js";
import { FAMILY_LAYERS, modelLayerFor, providerDoc } from "./provider-profile-layers.js";

const NATIVE_WIRE_API: Partial<Record<ProviderId, WireApi>> = {
  anthropic: "anthropic-messages",
  gemini: "gemini-generate-content",
  meta: "meta-responses",
  ollama: "ollama-chat",
};

export function providerWireApi(provider: ProviderId, model: string): WireApi {
  if (provider === "aws-mantle") {
    return /(?:^|[./-])(?:anthropic|claude)(?:[./-]|$)/i.test(model)
      ? "anthropic-messages"
      : "chat-completions";
  }
  return NATIVE_WIRE_API[provider] ?? "chat-completions";
}

export function builtInProfileLayers(
  provider: ProviderId,
  model: string,
): ProviderProfileSourceLayers {
  const family = FAMILY_LAYERS[provider];
  const modelLayer = modelLayerFor(provider, model);
  const overrideTokens = providerContextOverrideTokens(provider, model);
  const familyWithLimits: ProviderProfileLayer | undefined = family
    ? {
        ...family,
        limits: overrideTokens
          ? { contextTokens: overrideTokens, source: "catalog" }
          : family.limits,
      }
    : undefined;
  return {
    ...(familyWithLimits ? { family: familyWithLimits } : {}),
    ...(modelLayer ? { builtin: modelLayer } : {}),
  };
}

export function resolveBuiltInProfile(input: {
  provider: ProviderId;
  model: string;
  endpointHash?: string | undefined;
  credentialHash?: string | undefined;
  configGeneration?: string | undefined;
  catalogLayer?: ProviderProfileLayer | undefined;
}): ProviderProfile {
  const layers = builtInProfileLayers(input.provider, input.model);
  return applyObservedControlRejections(
    resolveProviderProfile({
      provider: input.provider,
      model: input.model,
      wireApi: providerWireApi(input.provider, input.model),
      endpointHash: input.endpointHash,
      credentialHash: input.credentialHash,
      configGeneration: input.configGeneration,
      layers: {
        ...layers,
        ...(input.catalogLayer ? { catalog: input.catalogLayer } : {}),
      },
    }),
  );
}

export function directDeepSeekV4Layer(): ProviderProfileLayer {
  return {
    evidence: providerDoc("deepseek-thinking-mode"),
    reasoning: {
      generation: "default-on",
      control: {
        dialect: "deepseek-thinking",
        status: "supported",
        evidence: providerDoc("deepseek-thinking-mode"),
      },
      acceptedEfforts: ["low", "high", "max"],
      disable: "supported",
      disableForm: "thinking-disabled",
      replayScope: "tool-turn",
      outputShapes: ["reasoning-content"],
    },
    limits: {
      contextTokens: 1_000_000,
      outputTokens: 384_000,
      source: "provider-doc",
    },
    cache: {
      kind: "automatic-prefix",
      cacheAffectingFields: ["messages", "tools", "thinking", "reasoning_effort"],
    },
    usage: {
      cachedInput: ["usage.prompt_cache_hit_tokens"],
      uncachedInput: ["usage.prompt_cache_miss_tokens"],
    },
    terminal: {
      proofs: ["done-sentinel", "finish-reason"],
      naturalEofAccepted: false,
    },
    capabilities: { tools: "supported" },
  };
}
