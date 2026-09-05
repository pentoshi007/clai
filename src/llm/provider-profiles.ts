import type { ProviderId } from "../types.js";
import {
  applyObservedControlRejections,
  CHAT_COMPLETIONS_TERMINAL_PROOFS,
  isBuiltInProviderId,
  resolveProviderProfile,
  type ProfileEvidence,
  type ProviderProfile,
  type ProviderProfileLayer,
  type ProviderProfileSourceLayers,
  type ReasoningControlDialect,
  type ReasoningGeneration,
  type WireApi,
} from "./provider-profile.js";
import { catalogEffortList, type CatalogFacts } from "./catalog-facts.js";
import { modelFamilyFor } from "./model-families.js";
import {
  isReasoningUnsupported,
  routeReasoningIsMandatory,
  catalogAdvertisedEfforts,
  modelCatalogFacts,
  learnedRouteEfforts,
  modelReasoningEfforts,
} from "./capabilities.js";
import { providerContextOverrideTokens } from "./token-usage.js";
import { modelLayerFor } from "./provider-model-layers.js";
import {
  FAMILY_LAYERS,
  FAMILYLESS_ENDPOINT_LAYERS,
  providerDoc,
} from "./provider-profile-layers.js";

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

export function catalogProfileLayer(
  facts: CatalogFacts,
): ProviderProfileLayer | undefined {
  const evidence: ProfileEvidence = { source: "catalog", confidence: "high" };
  const reasoning = facts.reasoning;
  const acceptedEfforts = catalogEffortList(reasoning?.supportedEfforts);
  const generation: ReasoningGeneration | undefined =
    reasoning?.mandatory === true
      ? "mandatory"
      : reasoning?.supported === false
        ? "none"
        : reasoning?.defaultEnabled === true
          ? "default-on"
          : reasoning?.supported === true
            ? "optional"
            : undefined;
  const samplingOmit: string[] = [];
  const samplingDefaults: Record<string, number> = {};
  for (const [field, value] of Object.entries(facts.defaultSampling ?? {})) {
    if (value === null) samplingOmit.push(field);
    else samplingDefaults[field] = value;
  }
  const reasoningLayer = {
    ...(generation !== undefined ? { generation } : {}),
    ...(acceptedEfforts !== undefined ? { acceptedEfforts } : {}),
    ...(reasoning?.defaultEffort !== undefined
      ? { defaultEffort: reasoning.defaultEffort }
      : {}),
    ...(reasoning?.mandatory === true
      ? { disable: "unsupported" as const }
      : reasoning?.mandatory === false
        ? { disable: "supported" as const }
        : {}),
  };
  const layer: ProviderProfileLayer = {
    evidence,
    ...(Object.keys(reasoningLayer).length > 0 ? { reasoning: reasoningLayer } : {}),
    ...(facts.acceptedParameters !== undefined
      ? { capabilities: { acceptedParameters: facts.acceptedParameters } }
      : {}),
    ...(facts.contextTokens !== undefined || facts.maxOutputTokens !== undefined
      ? {
          limits: {
            ...(facts.contextTokens !== undefined
              ? { contextTokens: facts.contextTokens }
              : {}),
            ...(facts.maxOutputTokens !== undefined
              ? { outputTokens: facts.maxOutputTokens }
              : {}),
            source: "catalog" as const,
          },
        }
      : {}),
    ...(samplingOmit.length > 0 || Object.keys(samplingDefaults).length > 0
      ? { sampling: { omit: samplingOmit, defaults: samplingDefaults } }
      : {}),
  };
  return Object.keys(layer).length > 1 ? layer : undefined;
}

export function catalogLayerFor(
  provider: string,
  model: string,
): ProviderProfileLayer | undefined {
  const facts = modelCatalogFacts(provider, model);
  return facts ? catalogProfileLayer(facts) : undefined;
}

export function modelFamilyLayerFor(
  provider: string,
  model: string,
  endpointDialect?: ReasoningControlDialect | undefined,
): ProviderProfileLayer | undefined {
  const family = modelFamilyFor(model);
  if (!family) return undefined;
  const evidence: ProfileEvidence = {
    source: "family",
    confidence: "high",
    detail: family.id,
  };
  const hasControl = family.dialect !== "none";
  return {
    evidence,
    reasoning: {
      generation: family.generation,
      generationEvidence: evidence,
      acceptedEfforts: family.acceptedEfforts,
      disable: family.disableForm === "none-documented" ? "unsupported" : "supported",
      disableForm: family.disableForm,
      finalTurnPreservation: family.finalTurnPreservation,
      ...(endpointDialect === undefined
        ? {
            control: {
              dialect: family.dialect,
              status: hasControl ? ("supported" as const) : ("unsupported" as const),
              evidence,
            },
          }
        : {}),
      ...(family.replayOptIn &&
      (endpointDialect === undefined || endpointDialect === family.dialect)
        ? { replayOptIn: family.replayOptIn }
        : {}),
      ...(family.defaultEffort ? { defaultEffort: family.defaultEffort } : {}),
      ...(family.minOutputTokensWithReasoning !== undefined
        ? { minOutputTokens: family.minOutputTokensWithReasoning }
        : {}),
    },
    ...(family.omitSampling ? { sampling: { omit: family.omitSampling } } : {}),
    ...(family.terminalProofs
      ? {
          terminal: {
            proofs: family.terminalProofs,
            naturalEofAccepted: false,
          },
        }
      : {}),
  };
}

function endpointControlDialect(
  ...layers: readonly (ProviderProfileLayer | undefined)[]
): ReasoningControlDialect | undefined {
  for (const layer of layers) {
    const control = layer?.reasoning?.control;
    if (!control) continue;
    if (control.dialect === "none" && control.status === "unknown") continue;
    return control.dialect;
  }
  return undefined;
}

export function builtInProfileLayers(
  provider: ProviderId,
  model: string,
): ProviderProfileSourceLayers {
  const family = FAMILY_LAYERS[provider];
  const modelLayer = modelLayerFor(provider, model);
  const modelFamilyLayer = modelFamilyLayerFor(
    provider,
    model,
    endpointControlDialect(modelLayer, family),
  );
  const overrideTokens = providerContextOverrideTokens(provider, model);
  const effectiveFamily = modelFamilyLayer
    ? family
    : (FAMILYLESS_ENDPOINT_LAYERS[provider] ?? family);
  const familyWithLimits: ProviderProfileLayer | undefined = effectiveFamily
    ? {
        ...effectiveFamily,
        limits: overrideTokens
          ? { contextTokens: overrideTokens, source: "catalog" }
          : effectiveFamily.limits,
      }
    : undefined;
  const catalog = catalogLayerFor(provider, model);
  const catalogWithoutOverriddenContext: ProviderProfileLayer | undefined =
    catalog && overrideTokens && catalog.limits
      ? {
          ...catalog,
          limits: {
            ...(catalog.limits.outputTokens !== undefined
              ? { outputTokens: catalog.limits.outputTokens }
              : {}),
            source: "catalog",
          },
        }
      : catalog;
  return {
    ...(familyWithLimits ? { family: familyWithLimits } : {}),
    ...(modelFamilyLayer ? { modelFamily: modelFamilyLayer } : {}),
    ...(modelLayer ? { builtin: modelLayer } : {}),
    ...(catalogWithoutOverriddenContext
      ? { catalog: catalogWithoutOverriddenContext }
      : {}),
  };
}

function observedReasoningOverlay(profile: ProviderProfile): ProviderProfile {
  const { provider, model } = profile.route;
  if (!isBuiltInProviderId(provider)) return profile;
  const mandatory = routeReasoningIsMandatory(provider, model);
  const suppressed = !mandatory && isReasoningUnsupported(provider, model);
  const wireEfforts = learnedRouteEfforts(provider, model);
  const advertised = catalogAdvertisedEfforts(provider, model);
  const learnedEfforts =
    wireEfforts ??
    advertised ??
    (profile.reasoning.acceptedEfforts.length === 0
      ? modelReasoningEfforts(provider, model)
      : undefined);
  if (!suppressed && !mandatory && !learnedEfforts?.length) return profile;
  const observed: ProfileEvidence = {
    source: "observed",
    confidence: "inferred",
  };
  return {
    ...profile,
    reasoning: {
      ...profile.reasoning,
      ...(learnedEfforts?.length ? { acceptedEfforts: learnedEfforts } : {}),
      ...(mandatory
        ? { generation: "mandatory" as const, disable: "unsupported" as const }
        : {}),
      ...(suppressed
        ? {
            control: {
              ...profile.reasoning.control,
              status: "unsupported" as const,
              evidence: observed,
            },
          }
        : {}),
    },
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
  return observedReasoningOverlay(
    applyObservedControlRejections(
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
    ),
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
      proofs: CHAT_COMPLETIONS_TERMINAL_PROOFS,
      naturalEofAccepted: false,
    },
    capabilities: { tools: "supported" },
  };
}
