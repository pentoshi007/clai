import type { ProviderId } from "../types.js";
import { classifyBynaraModel, classifyNvidiaModel } from "./model-families.js";
import { CHAT_COMPLETIONS_TERMINAL_PROOFS } from "./provider-profile.js";
import type {
  ProfileEvidence,
  ProviderProfileLayer,
} from "./provider-profile.js";

export const codeFact = (detail?: string): ProfileEvidence => ({
  source: "builtin",
  confidence: "exact",
  ...(detail ? { detail } : {}),
});

export const providerDoc = (detail: string): ProfileEvidence => ({
  source: "builtin",
  confidence: "high",
  detail,
});

export const viaGateway = (detail: string): ProfileEvidence => ({
  source: "builtin",
  confidence: "inferred",
  detail,
});

export const FAMILY_LAYERS: Partial<Record<ProviderId, ProviderProfileLayer>> = {
  anthropic: {
    evidence: providerDoc("anthropic-messages"),
    transport: { authType: "native", systemPolicy: "provider-system-field" },
    capabilities: {
      tools: "supported",
      images: "supported",
      streamOptions: "unsupported",
    },
    reasoning: {
      control: {
        dialect: "anthropic-thinking",
        status: "supported",
        evidence: providerDoc("anthropic-thinking"),
      },
      acceptedEfforts: ["low", "medium", "high"],
      disable: "supported",
      disableForm: "omit-control",
      outputShapes: ["signed-thinking-block"],
      replayScope: "tool-turn",
      finalTurnPreservation: "unsupported",
    },
    cache: {
      kind: "explicit-breakpoint",
      affinityField: "cache_control",
      cacheAffectingFields: ["system", "messages", "tools", "cache_control"],
    },
    usage: {
      cachedInput: ["usage.cache_read_input_tokens"],
      cacheWrite: ["usage.cache_creation_input_tokens"],
    },
    terminal: { proofs: ["message-stop"], naturalEofAccepted: false },
  },
  gemini: {
    evidence: providerDoc("gemini-generate-content"),
    transport: { authType: "native", systemPolicy: "provider-system-field" },
    capabilities: { tools: "supported", images: "supported" },
    reasoning: {
      control: {
        dialect: "gemini-thinking-config",
        status: "supported",
        evidence: providerDoc("gemini-thinking-config"),
      },
      disable: "supported",
      disableForm: "thinking-budget-zero",
      outputShapes: ["thought-signature"],
      replayScope: "tool-turn",
      finalTurnPreservation: "supported",
    },
    cache: {
      kind: "explicit-breakpoint",
      cacheAffectingFields: ["systemInstruction", "contents", "tools", "cachedContent"],
    },
    usage: {
      cachedInput: ["usageMetadata.cachedContentTokenCount"],
      reasoningOutput: ["usageMetadata.thoughtsTokenCount"],
    },
    terminal: { proofs: ["finish-reason"], naturalEofAccepted: false },
  },
  meta: {
    evidence: providerDoc("meta-responses"),
    transport: { authType: "native", systemPolicy: "provider-system-field" },
    capabilities: { tools: "supported" },
    reasoning: {
      generation: "mandatory",
      generationEvidence: providerDoc("meta-mandatory-reasoning"),
      control: {
        dialect: "meta-reasoning-effort",
        status: "supported",
        evidence: providerDoc("meta-reasoning-effort"),
      },
      acceptedEfforts: ["minimal", "low", "high", "xhigh"],
      disable: "unsupported",
      outputShapes: ["encrypted-reasoning-items"],
      replayScope: "tool-turn",
      finalTurnPreservation: "unsupported",
    },
    outputBudget: {
      sharedReasoningCap: true,
      visibleAnswerReserveTokens: 2048,
      mandatoryReasoningReserveTokens: 2048,
    },
    cache: {
      kind: "automatic-prefix",
      affinityField: "prompt_cache_key",
      cacheAffectingFields: [
        "input",
        "tools",
        "instructions",
        "prompt_cache_key",
        "prompt_cache_retention",
      ],
    },
    usage: {
      cachedInput: ["usage.input_tokens_details.cached_tokens"],
      cacheWrite: ["usage.cache_creation_input_tokens"],
      uncachedInput: ["usage.prompt_cache_miss_tokens"],
    },
    terminal: {
      proofs: ["response-completed", "response-incomplete"],
      naturalEofAccepted: false,
    },
  },
  ollama: {
    evidence: codeFact("ollama-chat"),
    transport: { authType: "none-keyless", systemPolicy: "single-leading" },
    capabilities: { tools: "unknown", images: "unknown" },
    reasoning: {
      control: {
        dialect: "ollama-think",
        status: "unknown",
        evidence: codeFact("think-is-model-scoped"),
      },
      outputShapes: ["ollama-thinking"],
      replayScope: "none",
    },
    terminal: { proofs: ["done-true"], naturalEofAccepted: false },
  },
  openai: {
    evidence: providerDoc("openai-chat-completions"),
    transport: { authType: "bearer", systemPolicy: "developer-fallback" },
    capabilities: {
      tools: "supported",
      images: "supported",
      structuredOutput: "supported",
      streamOptions: "supported",
    },
    reasoning: {
      generation: "optional",
      control: {
        dialect: "openai-effort",
        status: "supported",
        evidence: providerDoc("openai-reasoning-effort"),
      },
      acceptedEfforts: ["minimal", "low", "medium", "high"],
      disable: "supported",
      disableForm: "omit-control",
      replayScope: "none",
      finalTurnPreservation: "unsupported",
    },
    cache: {
      kind: "automatic-prefix",
      cacheAffectingFields: ["messages", "tools", "tool_choice", "images"],
    },
    usage: {
      cachedInput: ["usage.prompt_tokens_details.cached_tokens"],
      reasoningOutput: ["usage.completion_tokens_details.reasoning_tokens"],
    },
    terminal: {
      proofs: CHAT_COMPLETIONS_TERMINAL_PROOFS,
      naturalEofAccepted: false,
    },
  },
  openrouter: {
    evidence: providerDoc("openrouter-reasoning"),
    capabilities: { tools: "supported", images: "unknown" },
    reasoning: {
      control: {
        dialect: "openai-nested-reasoning",
        status: "supported",
        evidence: providerDoc("openrouter-reasoning"),
      },
      acceptedEfforts: ["low", "medium", "high"],
      outputShapes: ["reasoning-content", "structured-details"],
      replayScope: "tool-turn",
      replayOptIn: "openrouter-reasoning-context",
    },
    cache: {
      kind: "affinity-key",
      affinityField: "session_id",
      cacheAffectingFields: [
        "messages",
        "tools",
        "tool_choice",
        "reasoning",
        "session_id",
      ],
    },
    usage: {
      cachedInput: ["usage.prompt_tokens_details.cached_tokens"],
      cacheWrite: ["usage.prompt_tokens_details.cache_write_tokens"],
      reasoningOutput: ["usage.completion_tokens_details.reasoning_tokens"],
    },
    terminal: {
      proofs: CHAT_COMPLETIONS_TERMINAL_PROOFS,
      naturalEofAccepted: false,
    },
  },
  nvidia: {
    evidence: codeFact("nvidia-nim"),
    capabilities: { tools: "supported" },
    reasoning: {
      control: {
        dialect: "chat-template-thinking",
        status: "unknown",
        evidence: codeFact("nvidia-model-families"),
      },
      outputShapes: ["reasoning-content"],
    },
    terminal: {
      proofs: CHAT_COMPLETIONS_TERMINAL_PROOFS,
      naturalEofAccepted: false,
    },
  },
  agentrouter: {
    evidence: codeFact("agentrouter-live-verified-2026-07"),
    capabilities: { tools: "supported" },
    reasoning: {
      control: {
        dialect: "openai-effort",
        status: "unknown",
        evidence: codeFact("agentrouter-family-dependent"),
      },
      outputShapes: ["reasoning-content"],
    },
    terminal: {
      proofs: CHAT_COMPLETIONS_TERMINAL_PROOFS,
      naturalEofAccepted: false,
    },
  },
  bynara: {
    evidence: codeFact("bynara-route"),
    capabilities: { tools: "supported" },
    reasoning: {
      control: {
        dialect: "openai-effort",
        status: "unknown",
        evidence: codeFact("bynara-model-families"),
      },
      outputShapes: ["reasoning-content"],
    },
    terminal: {
      proofs: CHAT_COMPLETIONS_TERMINAL_PROOFS,
      naturalEofAccepted: false,
    },
  },
  "qwen-cloud": {
    evidence: providerDoc("alibaba-model-studio"),
    transport: { authType: "bearer", systemPolicy: "single-leading" },
    capabilities: { tools: "supported", images: "unknown" },
    reasoning: {
      control: {
        dialect: "qwen-enable-thinking",
        status: "supported",
        evidence: providerDoc("alibaba-enable-thinking"),
      },
      disable: "supported",
      disableForm: "enable-thinking-false",
      outputShapes: ["reasoning-content"],
      replayScope: "configurable",
      finalTurnPreservation: "supported",
    },
    terminal: {
      proofs: CHAT_COMPLETIONS_TERMINAL_PROOFS,
      naturalEofAccepted: false,
    },
  },
  modal: {
    evidence: providerDoc("modal-proxy-auth"),
    transport: { authType: "proxy-headers", systemPolicy: "single-leading" },
    capabilities: { tools: "unknown", images: "unknown" },
    reasoning: {
      control: {
        dialect: "modal-advertised-effort",
        status: "unknown",
        evidence: providerDoc("modal-deployment-owned"),
      },
      outputShapes: ["reasoning-content"],
    },
    cache: { kind: "unknown", cacheAffectingFields: [] },
  },
  lightning: {
    evidence: codeFact("lightning-catalog"),
    capabilities: { tools: "supported", images: "unknown" },
    reasoning: {
      control: {
        dialect: "openai-effort",
        status: "unknown",
        evidence: codeFact("lightning-catalog-scoped"),
      },
      outputShapes: ["reasoning-content"],
    },
    terminal: {
      proofs: CHAT_COMPLETIONS_TERMINAL_PROOFS,
      naturalEofAccepted: false,
    },
  },
  tokenrouter: {
    evidence: codeFact("tokenrouter-unknown-contract"),
    capabilities: { tools: "supported", images: "unknown" },
    reasoning: {
      control: {
        dialect: "openai-effort",
        status: "supported",
        evidence: providerDoc("tokenrouter-reasoning-effort-validated"),
      },
      outputShapes: ["reasoning-content"],
    },
    cache: { kind: "unknown", cacheAffectingFields: [] },
    terminal: {
      proofs: CHAT_COMPLETIONS_TERMINAL_PROOFS,
      naturalEofAccepted: false,
    },
  },
  fireworks: {
    evidence: providerDoc("fireworks-chat-completions"),
    capabilities: { tools: "supported" },
    reasoning: {
      control: {
        dialect: "openai-effort",
        status: "supported",
        evidence: providerDoc("fireworks-reasoning-effort"),
      },
      outputShapes: ["reasoning-content"],
    },
    cache: {
      kind: "affinity-key",
      affinityField: "prompt_cache_key",
      isolationField: "prompt_cache_isolation_key",
      cacheAffectingFields: [
        "messages",
        "tools",
        "allowed_tools",
        "reasoning_effort",
        "reasoning_history",
        "prompt_cache_key",
        "prompt_cache_isolation_key",
      ],
    },
    terminal: {
      proofs: CHAT_COMPLETIONS_TERMINAL_PROOFS,
      naturalEofAccepted: false,
    },
  },
  hetzner: {
    evidence: codeFact("hetzner-experiments"),
    capabilities: { tools: "supported" },
    reasoning: {
      control: {
        dialect: "glm-enable-thinking",
        status: "unknown",
        evidence: codeFact("hetzner-stepfun-style"),
      },
      outputShapes: ["reasoning-content"],
    },
    terminal: {
      proofs: CHAT_COMPLETIONS_TERMINAL_PROOFS,
      naturalEofAccepted: false,
    },
  },
  "merge-gateway": {
    evidence: providerDoc("merge-gateway-reasoning"),
    capabilities: { tools: "supported", images: "unknown" },
    reasoning: {
      control: {
        dialect: "openai-effort",
        status: "supported",
        evidence: providerDoc("merge-gateway-openai-route"),
      },
      acceptedEfforts: ["low", "medium", "high"],
      outputShapes: ["reasoning-content", "reasoning-field"],
      replayScope: "tool-turn",
    },
    usage: {
      cachedInput: ["usage.prompt_tokens_details.cached_tokens"],
    },
    terminal: {
      proofs: CHAT_COMPLETIONS_TERMINAL_PROOFS,
      naturalEofAccepted: false,
    },
  },
  orcarouter: {
    evidence: providerDoc("orcarouter-reasoning"),
    capabilities: { tools: "supported", images: "unknown" },
    reasoning: {
      control: {
        dialect: "openai-effort",
        status: "supported",
        evidence: providerDoc("orcarouter-unified-effort"),
      },
      acceptedEfforts: ["low", "medium", "high"],
      outputShapes: ["reasoning-content"],
      replayScope: "tool-turn",
    },
    usage: {
      cachedInput: ["usage.prompt_tokens_details.cached_tokens"],
    },
    terminal: {
      proofs: CHAT_COMPLETIONS_TERMINAL_PROOFS,
      naturalEofAccepted: false,
    },
  },
  free: {
    evidence: codeFact("zen-kilo-free-gateways"),
    transport: { authType: "none-keyless", systemPolicy: "single-leading" },
    capabilities: { tools: "supported" },
    reasoning: {
      control: {
        dialect: "none",
        status: "unknown",
        evidence: codeFact("free-gateway-contracts-unknown"),
      },
      outputShapes: ["reasoning-content"],
    },
    terminal: {
      proofs: CHAT_COMPLETIONS_TERMINAL_PROOFS,
      naturalEofAccepted: false,
    },
  },
  "aws-mantle": {
    evidence: codeFact("aws-mantle-compatible"),
    capabilities: { tools: "supported" },
    reasoning: {
      control: {
        dialect: "chat-template-thinking",
        status: "unknown",
        evidence: codeFact("aws-mantle-model-scoped"),
      },
      outputShapes: ["reasoning-content"],
    },
    terminal: {
      proofs: CHAT_COMPLETIONS_TERMINAL_PROOFS,
      naturalEofAccepted: false,
    },
  },
};

const freeGatewayEffortLayer: ProviderProfileLayer = {
  evidence: codeFact("zen-kilo-free-effort-probed"),
  transport: { authType: "none-keyless", systemPolicy: "single-leading" },
  capabilities: { tools: "supported" },
  reasoning: {
    control: {
      dialect: "openai-effort",
      status: "supported",
      evidence: codeFact("zen-kilo-free-effort-probed"),
    },
    generation: "optional",
    acceptedEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    disable: "supported",
    disableForm: "effort-none",
    outputShapes: ["reasoning-content", "reasoning-field", "structured-details"],
  },
  outputBudget: {
    sharedReasoningCap: true,
    visibleAnswerReserveTokens: 1024,
    mandatoryReasoningReserveTokens: 0,
  },
  terminal: {
    proofs: CHAT_COMPLETIONS_TERMINAL_PROOFS,
    naturalEofAccepted: false,
  },
};

export const FAMILYLESS_ENDPOINT_LAYERS: Partial<
  Record<ProviderId, ProviderProfileLayer>
> = {
  free: freeGatewayEffortLayer,
};

export const kimiMandatoryLayer: ProviderProfileLayer = {  evidence: viaGateway("kimi-k3-k2p7-official-contract"),
  reasoning: {
    generation: "mandatory",
    replayScope: "all-history",
    finalTurnPreservation: "required",
  },
  outputBudget: {
    sharedReasoningCap: true,
    visibleAnswerReserveTokens: 2048,
    mandatoryReasoningReserveTokens: 4096,
  },
};

export const kimiConfigurableLayer: ProviderProfileLayer = {
  evidence: viaGateway("kimi-k2p6-official-contract"),
  reasoning: {
    generation: "optional",
    replayScope: "configurable",
    finalTurnPreservation: "supported",
  },
};

export const kimiNoPreservationLayer: ProviderProfileLayer = {
  evidence: viaGateway("kimi-k2p5-official-contract"),
  reasoning: {
    generation: "optional",
    replayScope: "tool-turn",
    finalTurnPreservation: "unsupported",
  },
};

export const deepseekV4DefaultOn: ProviderProfileLayer = {
  evidence: viaGateway("deepseek-v4-default-thinking"),
  reasoning: {
    generation: "default-on",
    replayScope: "tool-turn",
    outputShapes: ["reasoning-content"],
  },
};
