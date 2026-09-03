import type { ProviderId } from "../types.js";
import { classifyBynaraModel } from "./model-families.js";
import type { ProviderProfileLayer } from "./provider-profile.js";
import {
  codeFact,
  kimiConfigurableLayer,
  kimiMandatoryLayer,
  kimiNoPreservationLayer,
  providerDoc,
} from "./provider-profile-layers.js";
import { MODEL_RULES } from "./model-layers/model-rules.js";
import { nvidiaModelLayer } from "./model-layers/nvidia-layer.js";
import {
  AWS_MANTLE_ANTHROPIC_MODEL,
  LING_NO_REASONING,
  LING_PATTERN,
  OPENROUTER_REASONING_PATTERN,
  QWEN3_MAX_GATEWAY_EFFORTS,
  QWEN3_MAX_PATTERN,
} from "./model-layers/model-patterns.js";
export { QWEN3_MAX_GATEWAY_EFFORTS, QWEN3_MAX_PATTERN };

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
    case "qwen":
      return {
        evidence: codeFact("bynara-qwen38-live-probed"),
        reasoning: {
          generation: "default-on",
          control: {
            dialect: "openai-effort",
            status: "supported",
            evidence: codeFact("bynara-qwen38-live-probed"),
          },
          acceptedEfforts: ["low", "medium", "xhigh"],
          disable: "supported",
          disableForm: "effort-none",
        },
      };
    default:
      return undefined;
  }
}

function agentrouterModelLayer(
  model: string,
): ProviderProfileLayer | undefined {
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
