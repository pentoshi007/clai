import { catalogEffortList, type CatalogFacts } from "./catalog-facts.js";
import { CHAT_COMPLETIONS_TERMINAL_PROOFS, type ProviderProfileLayer } from "./provider-profile.js";

const evidence = {
  source: "builtin" as const,
  confidence: "high" as const,
  detail: "https://docs.constellationgate.ai/guides/openai-sdk/",
};

export const constellationProfile: ProviderProfileLayer = {
  evidence,
  transport: { authType: "bearer", keyEnv: "GATE_API_KEY", systemPolicy: "single-leading" },
  capabilities: { tools: "supported", streamOptions: "supported" },
  reasoning: {
    control: { dialect: "openai-effort", status: "supported", evidence },
    acceptedEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    disableForm: "effort-none",
    outputShapes: ["reasoning-content", "reasoning-field", "structured-details"],
    replayScope: "tool-turn",
    finalTurnPreservation: "unsupported",
  },
  cache: {
    kind: "automatic-prefix",
    cacheAffectingFields: ["model", "messages", "tools", "tool_choice", "reasoning_effort"],
  },
  usage: {
    cachedInput: ["usage.prompt_tokens_details.cached_tokens", "usage.cache_read_input_tokens"],
    cacheWrite: ["usage.cache_creation_input_tokens"],
    reasoningOutput: ["usage.completion_tokens_details.reasoning_tokens"],
  },
  terminal: { proofs: CHAT_COMPLETIONS_TERMINAL_PROOFS, naturalEofAccepted: false },
};

export function constellationModelLayer(facts: CatalogFacts | undefined): ProviderProfileLayer | undefined {
  const reasoning = facts?.reasoning;
  if (!reasoning) return undefined;
  const efforts = catalogEffortList(reasoning.supportedEfforts);
  return {
    evidence: { source: "catalog", confidence: "high" },
    reasoning: {
      generation: reasoning.supported === false ? "none"
        : reasoning.mandatory ? "mandatory" : reasoning.defaultEnabled ? "default-on" : "optional",
      control: {
        dialect: "openai-effort",
        status: reasoning.supported === false ? "unsupported" : "supported",
        evidence,
      },
      acceptedEfforts: efforts ?? [],
      disable: reasoning.mandatory ? "unsupported" : "supported",
      disableForm: efforts?.includes("none") || !efforts?.length ? "effort-none" : "omit-control",
    },
  };
}
