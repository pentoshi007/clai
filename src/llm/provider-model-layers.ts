import type { ProviderId } from "../types.js";
import { classifyBynaraModel, classifyNvidiaModel } from "./model-families.js";
import type { ProviderProfileLayer } from "./provider-profile.js";
import {
  codeFact,
  deepseekV4DefaultOn,
  kimiConfigurableLayer,
  kimiMandatoryLayer,
  kimiNoPreservationLayer,
  providerDoc,
  viaGateway,
} from "./provider-profile-layers.js";

interface ModelRule {
  readonly pattern: RegExp;
  readonly layer: ProviderProfileLayer;
}

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
  if (LING_PATTERN.test(model)) return LING_NO_REASONING;
  if (QWEN3_MAX_PATTERN.test(model)) return QWEN3_MAX_GATEWAY_EFFORTS;
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
            dialect: "openai-effort",
            status: "supported",
            evidence: codeFact("bynara-stepfun"),
          },
          acceptedEfforts: ["low", "medium", "high"],
          disable: "unsupported",
          disableForm: "none-documented",
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
          dialect: "openai-effort",
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

const QWEN3_MAX_GATEWAY_EFFORTS: ProviderProfileLayer = {
  evidence: providerDoc("qwen3-max-gateway-serves-low-medium-only"),
  reasoning: {
    acceptedEfforts: ["low", "medium"],
    control: {
      dialect: "openai-effort",
      status: "supported",
      evidence: providerDoc("qwen3-max-gateway-serves-low-medium-only"),
    },
  },
};

const QWEN3_MAX_PATTERN = /qwen-?3\.?8-?max/i;

const LING_PATTERN = /(?:^|[-/])ling-?3(?:[.-]|$)/i;

const LING_NO_REASONING: ProviderProfileLayer = {
  evidence: providerDoc("ling-3-returns-no-reasoning-content"),
  reasoning: {
    generation: "none",
    control: {
      dialect: "none",
      status: "unsupported",
      evidence: providerDoc("ling-3-returns-no-reasoning-content"),
    },
    disable: "supported",
    disableForm: "omit-control",
  },
};

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
      pattern: /gemini-3(?:\.\d+)?-pro/i,
      layer: {
        evidence: codeFact("gemini-3-thinking-level-pro-has-no-minimal"),
        reasoning: {
          generation: "optional",
          acceptedEfforts: ["low", "medium", "high"],
        },
      },
    },
    {
      pattern: /gemini-3(?:[.-]|$)/i,
      layer: {
        evidence: codeFact("gemini-3-thinking-level"),
        reasoning: {
          generation: "optional",
          acceptedEfforts: ["minimal", "low", "medium", "high"],
        },
      },
    },
    {
      pattern: /gemini-2\.5-(?:flash|flash-lite)/i,
      layer: {
        evidence: codeFact("gemini-2p5-thinking-budget"),
        reasoning: {
          generation: "optional",
          acceptedEfforts: ["low", "medium", "high"],
          disable: "supported",
          disableForm: "thinking-budget-zero",
        },
      },
    },
    {
      pattern: /gemini-2\.5/i,
      layer: {
        evidence: codeFact("gemini-2p5-pro-cannot-disable-thinking"),
        reasoning: {
          generation: "mandatory",
          acceptedEfforts: ["low", "medium", "high"],
          disable: "unsupported",
        },
      },
    },
    {
      pattern: /gemini/i,
      layer: {
        evidence: codeFact("gemini-pre-2p5-has-no-thinking-config"),
        reasoning: {
          generation: "none",
          control: {
            dialect: "none",
            status: "unsupported",
            evidence: codeFact("gemini-pre-2p5-has-no-thinking-config"),
          },
        },
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
  tokenrouter: [
    { pattern: QWEN3_MAX_PATTERN, layer: QWEN3_MAX_GATEWAY_EFFORTS },
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
  "merge-gateway": [
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
