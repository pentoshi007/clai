import type { ProviderId } from "../types.js";
import { classifyBynaraModel, classifyNvidiaModel } from "./model-families.js";
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

interface ModelRule {
  readonly pattern: RegExp;
  readonly layer: ProviderProfileLayer;
}

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
      proofs: ["done-sentinel", "finish-reason"],
      naturalEofAccepted: false,
    },
  },
  groq: {
    evidence: codeFact("groq-route"),
    capabilities: { tools: "supported", streamOptions: "supported" },
    reasoning: {
      control: {
        dialect: "groq-model-specific",
        status: "unknown",
        evidence: codeFact("groq-model-specific-controls"),
      },
    },
    cache: { kind: "unknown", cacheAffectingFields: [] },
    terminal: {
      proofs: ["done-sentinel", "finish-reason"],
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
    },
    cache: { kind: "unknown", cacheAffectingFields: [] },
    usage: {
      cachedInput: ["usage.prompt_tokens_details.cached_tokens"],
    },
    terminal: {
      proofs: ["done-sentinel", "finish-reason"],
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
      proofs: ["done-sentinel", "finish-reason"],
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
      proofs: ["done-sentinel", "finish-reason"],
      naturalEofAccepted: false,
    },
  },
  kimchi: {
    evidence: codeFact("kimchi-gateway"),
    capabilities: { tools: "supported" },
    reasoning: {
      control: {
        dialect: "none",
        status: "unknown",
        evidence: viaGateway("kimi-contract-via-gateway"),
      },
      outputShapes: ["reasoning-content"],
    },
    terminal: {
      proofs: ["done-sentinel", "finish-reason"],
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
      proofs: ["done-sentinel", "finish-reason"],
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
      proofs: ["done-sentinel", "finish-reason"],
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
      proofs: ["done-sentinel", "finish-reason"],
      naturalEofAccepted: false,
    },
  },
  tokenrouter: {
    evidence: codeFact("tokenrouter-unknown-contract"),
    capabilities: { tools: "supported", images: "unknown" },
    reasoning: {
      control: {
        dialect: "none",
        status: "unknown",
        evidence: codeFact("tokenrouter-contract-unknown"),
      },
      outputShapes: ["reasoning-content"],
    },
    cache: { kind: "unknown", cacheAffectingFields: [] },
    terminal: {
      proofs: ["done-sentinel", "finish-reason"],
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
      proofs: ["done-sentinel", "finish-reason"],
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
      proofs: ["done-sentinel", "finish-reason"],
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
      proofs: ["done-sentinel", "finish-reason"],
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
      proofs: ["done-sentinel", "finish-reason"],
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
      proofs: ["done-sentinel", "finish-reason"],
      naturalEofAccepted: false,
    },
  },
};

const kimiMandatoryLayer: ProviderProfileLayer = {
  evidence: viaGateway("kimi-k3-k2p7-official-contract"),
  reasoning: {
    generation: "mandatory",
    control: {
      dialect: "none",
      status: "unknown",
      evidence: viaGateway("kimi-toggle-not-sent"),
    },
    replayScope: "all-history",
    finalTurnPreservation: "required",
  },
  outputBudget: {
    sharedReasoningCap: true,
    visibleAnswerReserveTokens: 2048,
    mandatoryReasoningReserveTokens: 4096,
  },
};

const kimiConfigurableLayer: ProviderProfileLayer = {
  evidence: viaGateway("kimi-k2p6-official-contract"),
  reasoning: {
    generation: "optional",
    replayScope: "configurable",
    finalTurnPreservation: "supported",
  },
};

const kimiNoPreservationLayer: ProviderProfileLayer = {
  evidence: viaGateway("kimi-k2p5-official-contract"),
  reasoning: {
    generation: "optional",
    replayScope: "tool-turn",
    finalTurnPreservation: "unsupported",
  },
};

const deepseekV4DefaultOn: ProviderProfileLayer = {
  evidence: viaGateway("deepseek-v4-default-thinking"),
  reasoning: {
    generation: "default-on",
    replayScope: "tool-turn",
    outputShapes: ["reasoning-content"],
  },
};

function nvidiaModelLayer(model: string): ProviderProfileLayer | undefined {
  switch (classifyNvidiaModel(model)) {
    case "kimi-thinking":
      return {
        evidence: codeFact("nim-kimi-thinking"),
        reasoning: {
          generation: "default-on",
          control: {
            dialect: "kimi-template-thinking",
            status: "supported",
            evidence: codeFact("nim-kimi-thinking"),
          },
          disable: "supported",
          disableForm: "template-thinking-false",
          replayScope: "tool-turn",
        },
      };
    case "deepseek-v4":
      return {
        evidence: codeFact("nim-deepseek-v4"),
        reasoning: {
          generation: "default-on",
          control: {
            dialect: "chat-template-thinking",
            status: "supported",
            evidence: codeFact("nim-deepseek-v4"),
          },
          acceptedEfforts: ["none", "high"],
          disable: "supported",
          disableForm: "template-thinking-false",
          replayScope: "tool-turn",
          outputShapes: ["reasoning-content"],
        },
      };
    case "thinking":
      return {
        evidence: codeFact("nim-chat-template-thinking"),
        reasoning: {
          generation: "default-on",
          control: {
            dialect: "chat-template-thinking",
            status: "supported",
            evidence: codeFact("nim-chat-template-thinking"),
          },
          disable: "supported",
          disableForm: "template-thinking-false",
        },
      };
    case "nemotron-3":
      return {
        evidence: codeFact("nim-nemotron-3"),
        reasoning: {
          control: {
            dialect: "nemotron-reasoning-budget",
            status: "supported",
            evidence: codeFact("nim-nemotron-3"),
          },
          disable: "supported",
          disableForm: "template-enable-thinking-false",
        },
      };
    case "glm-thinking":
      return {
        evidence: codeFact("nim-glm-thinking"),
        reasoning: {
          control: {
            dialect: "glm-enable-thinking",
            status: "supported",
            evidence: codeFact("nim-glm-thinking"),
          },
          disable: "supported",
          disableForm: "template-enable-thinking-false",
        },
      };
    case "enable-thinking":
      return {
        evidence: codeFact("nim-gemma-enable-thinking"),
        reasoning: {
          control: {
            dialect: "glm-enable-thinking",
            status: "supported",
            evidence: codeFact("nim-gemma-enable-thinking"),
          },
          disable: "supported",
          disableForm: "template-enable-thinking-false",
        },
      };
    case "effort-only":
      if (/gpt-oss/i.test(model)) {
        return {
          evidence: codeFact("nim-gpt-oss-effort"),
          reasoning: {
            generation: "default-on",
            control: {
              dialect: "openai-effort",
              status: "supported",
              evidence: codeFact("nim-gpt-oss-effort"),
            },
            acceptedEfforts: ["low", "medium", "high"],
            disable: "unsupported",
            disableForm: "effort-minimal-floor",
          },
        };
      }
      return {
        evidence: codeFact("nim-effort-only"),
        reasoning: {
          generation: "default-on",
          control: {
            dialect: "openai-effort",
            status: "supported",
            evidence: codeFact("nim-effort-only"),
          },
          acceptedEfforts: ["none", "low", "medium", "high"],
          disable: "supported",
          disableForm: "effort-none",
        },
      };
    default:
      return {
        evidence: codeFact("nim-no-thinking-knob"),
        reasoning: {
          generation: "unknown",
          control: {
            dialect: "none",
            status: "unsupported",
            evidence: codeFact("nim-no-thinking-knob"),
          },
        },
      };
  }
}

function bynaraModelLayer(model: string): ProviderProfileLayer | undefined {
  switch (classifyBynaraModel(model)) {
    case "kimi":
      return {
        evidence: codeFact("bynara-kimi"),
        reasoning: {
          generation: "default-on",
          control: {
            dialect: "kimi-template-thinking",
            status: "supported",
            evidence: codeFact("bynara-kimi"),
          },
          acceptedEfforts: ["low", "high"],
          disable: "supported",
          disableForm: "template-thinking-false",
          replayScope: "tool-turn",
        },
      };
    case "deepseek":
    case "agnes":
      return {
        evidence: codeFact("bynara-effort"),
        reasoning: {
          generation: "default-on",
          control: {
            dialect: "openai-effort",
            status: "supported",
            evidence: codeFact("bynara-effort"),
          },
          acceptedEfforts: ["none", "low", "medium", "high"],
          disable: "supported",
          disableForm: "effort-none",
        },
      };
    case "stepfun":
      return {
        evidence: codeFact("bynara-stepfun"),
        reasoning: {
          control: {
            dialect: "glm-enable-thinking",
            status: "supported",
            evidence: codeFact("bynara-stepfun"),
          },
          disable: "supported",
          disableForm: "template-enable-thinking-false",
        },
      };
    default:
      return undefined;
  }
}

function agentrouterModelLayer(model: string): ProviderProfileLayer | undefined {
  const m = model.toLowerCase();
  if (/(?:^|\/)gpt-5|(?:^|\/)o[134](?:\b|-)/.test(m)) {
    return {
      evidence: codeFact("agentrouter-gpt-effort"),
      reasoning: {
        generation: "default-on",
        control: {
          dialect: "openai-effort",
          status: "supported",
          evidence: codeFact("agentrouter-gpt-effort"),
        },
        acceptedEfforts: ["minimal", "low", "medium", "high"],
        disable: "unsupported",
        disableForm: "effort-minimal-floor",
      },
    };
  }
  if (/glm/.test(m)) {
    return {
      evidence: codeFact("agentrouter-glm-disabled"),
      reasoning: {
        generation: "default-on",
        control: {
          dialect: "deepseek-thinking",
          status: "supported",
          evidence: codeFact("agentrouter-glm-disabled"),
        },
        disable: "supported",
        disableForm: "thinking-disabled",
      },
    };
  }
  if (/claude/.test(m)) {
    return {
      evidence: codeFact("agentrouter-claude-effort"),
      reasoning: {
        generation: "optional",
        control: {
          dialect: "anthropic-thinking",
          status: "supported",
          evidence: codeFact("agentrouter-claude-effort"),
        },
        acceptedEfforts: ["low", "medium", "high"],
        disable: "supported",
        disableForm: "omit-control",
      },
    };
  }
  return undefined;
}

const OPENROUTER_REASONING_PATTERN =
  /:thinking|deepseek-v4|deepseek-r1|qwen3|kimi-k[23]|claude-(?:opus|sonnet|haiku)-4|gpt-5|(?:^|\/)o[134]|grok.*reasoner/i;

function openrouterModelLayer(model: string): ProviderProfileLayer | undefined {
  if (/kimi-k3|kimi-k2\.7/.test(model)) return kimiMandatoryLayer;
  if (/kimi-k2\.6/.test(model)) return kimiConfigurableLayer;
  if (/kimi-k2\.5|kimi-k2(?:\b|-)/.test(model)) return kimiNoPreservationLayer;
  if (!OPENROUTER_REASONING_PATTERN.test(model)) return undefined;
  return {
    evidence: providerDoc("openrouter-reasoning"),
    reasoning: {
      generation: "default-on",
      control: {
        dialect: "openai-nested-reasoning",
        status: "supported",
        evidence: providerDoc("openrouter-reasoning"),
      },
      acceptedEfforts: ["low", "medium", "high"],
      replayScope: "tool-turn",
      outputShapes: ["reasoning-content", "structured-details"],
    },
  };
}

const MODEL_RULES: Partial<Record<ProviderId, readonly ModelRule[]>> = {
  anthropic: [
    {
      pattern: /claude-(?:opus|sonnet|haiku)-(?:3-7|4|5)|claude-3-7/i,
      layer: {
        evidence: providerDoc("anthropic-extended-thinking"),
        reasoning: { generation: "optional" },
      },
    },
    {
      pattern: /claude/i,
      layer: {
        evidence: providerDoc("anthropic-no-thinking"),
        reasoning: {
          generation: "none",
          control: {
            dialect: "none",
            status: "unsupported",
            evidence: providerDoc("anthropic-no-thinking"),
          },
        },
      },
    },
  ],
  gemini: [
    {
      pattern: /gemini-(?:2\.5|3|3\.5)/i,
      layer: {
        evidence: providerDoc("gemini-thinking"),
        reasoning: { generation: "optional" },
      },
    },
  ],
  ollama: [
    {
      pattern: /deepseek-r1|qwen3|qwq/i,
      layer: {
        evidence: codeFact("ollama-think-supported-families"),
        reasoning: {
          generation: "default-on",
          control: {
            dialect: "ollama-think",
            status: "supported",
            evidence: codeFact("ollama-think-supported-families"),
          },
          disable: "supported",
          disableForm: "omit-control",
        },
      },
    },
  ],
  openai: [
    {
      pattern: /gpt-5|(?:^|\/)o[134]/i,
      layer: {
        evidence: providerDoc("openai-reasoning-models"),
        reasoning: {
          generation: "optional",
          acceptedEfforts: ["minimal", "low", "medium", "high"],
          disable: "unsupported",
          disableForm: "effort-minimal-floor",
        },
      },
    },
    {
      pattern: /gpt-4o|gpt-4\.1|gpt-4-turbo/i,
      layer: {
        evidence: providerDoc("openai-non-reasoning"),
        reasoning: {
          generation: "none",
          control: {
            dialect: "none",
            status: "unsupported",
            evidence: providerDoc("openai-non-reasoning"),
          },
        },
      },
    },
  ],
  groq: [
    {
      pattern: /qwen\/qwen3-32b/i,
      layer: {
        evidence: codeFact("groq-qwen3-effort"),
        reasoning: {
          generation: "default-on",
          control: {
            dialect: "openai-effort",
            status: "supported",
            evidence: codeFact("groq-qwen3-effort"),
          },
          acceptedEfforts: ["default", "none"],
          disable: "supported",
          disableForm: "effort-none",
        },
      },
    },
    {
      pattern: /openai\/gpt-oss-(?:20b|120b)/i,
      layer: {
        evidence: codeFact("groq-gpt-oss-effort"),
        reasoning: {
          generation: "default-on",
          control: {
            dialect: "openai-effort",
            status: "supported",
            evidence: codeFact("groq-gpt-oss-effort"),
          },
          acceptedEfforts: ["low", "medium", "high"],
          disable: "unsupported",
          disableForm: "effort-minimal-floor",
        },
      },
    },
  ],
  fireworks: [
    {
      pattern: /deepseek-v4/i,
      layer: {
        evidence: providerDoc("fireworks-deepseek-v4"),
        reasoning: {
          generation: "default-on",
          acceptedEfforts: ["none", "high", "max"],
          disable: "supported",
          disableForm: "effort-none",
          replayScope: "tool-turn",
          outputShapes: ["reasoning-content"],
        },
      },
    },
    {
      pattern: /kimi-k3|kimi-k2\.7/i,
      layer: kimiMandatoryLayer,
    },
    {
      pattern: /kimi-k2\.6/i,
      layer: kimiConfigurableLayer,
    },
    {
      pattern: /kimi/i,
      layer: kimiNoPreservationLayer,
    },
  ],
  "qwen-cloud": [
    {
      pattern: /qwen3/i,
      layer: {
        evidence: providerDoc("alibaba-qwen3-thinking"),
        reasoning: { generation: "default-on" },
      },
    },
  ],
  hetzner: [
    {
      pattern: /qwen/i,
      layer: {
        evidence: codeFact("hetzner-qwen-thinking"),
        reasoning: {
          generation: "default-on",
          control: {
            dialect: "glm-enable-thinking",
            status: "supported",
            evidence: codeFact("hetzner-qwen-thinking"),
          },
          disable: "supported",
          disableForm: "template-enable-thinking-false",
        },
      },
    },
  ],
  kimchi: [
    { pattern: /kimi-k3|kimi-k2\.7/i, layer: kimiMandatoryLayer },
    { pattern: /kimi-k2\.6/i, layer: kimiConfigurableLayer },
    { pattern: /kimi/i, layer: kimiNoPreservationLayer },
  ],
  tokenrouter: [
    { pattern: /kimi-k3|kimi-k2\.7/i, layer: kimiMandatoryLayer },
    { pattern: /kimi-k2\.6/i, layer: kimiConfigurableLayer },
    { pattern: /kimi/i, layer: kimiNoPreservationLayer },
    { pattern: /deepseek/i, layer: deepseekV4DefaultOn },
  ],
  orcarouter: [
    { pattern: /kimi-k3|kimi-k2\.7/i, layer: kimiMandatoryLayer },
    { pattern: /kimi-k2\.6/i, layer: kimiConfigurableLayer },
    { pattern: /kimi/i, layer: kimiNoPreservationLayer },
    { pattern: /deepseek/i, layer: deepseekV4DefaultOn },
  ],
  modal: [
    { pattern: /kimi-k3|kimi-k2\.7/i, layer: kimiMandatoryLayer },
    { pattern: /kimi-k2\.6/i, layer: kimiConfigurableLayer },
    { pattern: /kimi/i, layer: kimiNoPreservationLayer },
    { pattern: /deepseek/i, layer: deepseekV4DefaultOn },
  ],
  lightning: [
    { pattern: /kimi-k3|kimi-k2\.7/i, layer: kimiMandatoryLayer },
    { pattern: /kimi-k2\.6/i, layer: kimiConfigurableLayer },
    { pattern: /kimi/i, layer: kimiNoPreservationLayer },
    { pattern: /deepseek/i, layer: deepseekV4DefaultOn },
  ],
  free: [{ pattern: /deepseek/i, layer: deepseekV4DefaultOn }],
  openrouter: [],
};


const AWS_MANTLE_ANTHROPIC_MODEL = /(?:^|[./-])(?:anthropic|claude)(?:[./-]|$)/i;

export function modelLayerFor(
  provider: ProviderId,
  model: string,
): ProviderProfileLayer | undefined {
  if (provider === "nvidia") return nvidiaModelLayer(model);
  if (provider === "bynara") return bynaraModelLayer(model);
  if (provider === "agentrouter") return agentrouterModelLayer(model);
  if (provider === "openrouter") return openrouterModelLayer(model);
  if (provider === "aws-mantle") {
    return AWS_MANTLE_ANTHROPIC_MODEL.test(model)
      ? MODEL_RULES.anthropic?.find((rule) => rule.pattern.test(model))?.layer
      : nvidiaModelLayer(model);
  }
  return MODEL_RULES[provider]?.find((rule) => rule.pattern.test(model))?.layer;
}
