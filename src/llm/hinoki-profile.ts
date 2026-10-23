import type { CatalogFacts } from "./catalog-facts.js";
import { catalogEffortList } from "./catalog-facts.js";
import { CHAT_COMPLETIONS_TERMINAL_PROOFS, type ProviderProfileLayer } from "./provider-profile.js";
import { WIRE_EFFORT_SCALE } from "./reasoning-controls.js";

const evidence = {
  source: "builtin" as const,
  confidence: "high" as const,
  detail: "https://inference.hinoki.security/v1",
};

export const hinokiProfile: ProviderProfileLayer = {
  evidence,
  transport: {
    authType: "bearer",
    keyEnv: "HINOKI_API_KEY",
    baseUrlEnv: "HINOKI_BASE_URL",
    systemPolicy: "single-leading",
  },
  capabilities: { tools: "supported", streamOptions: "supported" },
  reasoning: {
    generation: "optional",
    control: { dialect: "openai-effort", status: "supported", evidence },
    acceptedEfforts: WIRE_EFFORT_SCALE,
    disable: "supported",
    disableForm: "effort-none",
    outputShapes: ["reasoning-content", "reasoning-field", "structured-details"],
    replayScope: "tool-turn",
    finalTurnPreservation: "unsupported",
  },
  cache: {
    kind: "automatic-prefix",
    affinityField: "prompt_cache_key",
    cacheAffectingFields: ["model", "messages", "tools", "tool_choice", "reasoning_effort", "prompt_cache_key"],
  },
  usage: {
    cachedInput: ["usage.prompt_tokens_details.cached_tokens", "usage.cache_read_input_tokens"],
    cacheWrite: ["usage.cache_creation_input_tokens"],
    reasoningOutput: ["usage.completion_tokens_details.reasoning_tokens"],
  },
  terminal: { proofs: CHAT_COMPLETIONS_TERMINAL_PROOFS, naturalEofAccepted: false },
};

export function hinokiModelLayer(facts: CatalogFacts | undefined): ProviderProfileLayer | undefined {
  const reasoning = facts?.reasoning;
  if (!reasoning) return undefined;
  const supported = reasoning.supported !== false;
  const efforts = supported ? catalogEffortList(reasoning.supportedEfforts) ?? WIRE_EFFORT_SCALE : [];
  const catalogEvidence = { source: "catalog" as const, confidence: "high" as const };
  return {
    evidence: catalogEvidence,
    reasoning: {
      generation: !supported ? "none" : reasoning.mandatory ? "mandatory" : reasoning.defaultEnabled ? "default-on" : "optional",
      control: { dialect: "openai-effort", status: supported ? "supported" : "unsupported", evidence: catalogEvidence },
      acceptedEfforts: efforts,
      disable: reasoning.mandatory ? "unsupported" : "supported",
      disableForm: efforts.includes("none") ? "effort-none" : "omit-control",
    },
  };
}
