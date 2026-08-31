import type { ProviderId } from "../../types.js";
import {
  QWEN3_MAX_GATEWAY_EFFORTS,
  QWEN3_MAX_PATTERN,
} from "./model-patterns.js";
import {
  codeFact,
  deepseekV4DefaultOn,
  kimiConfigurableLayer,
  kimiMandatoryLayer,
  kimiNoPreservationLayer,
  providerDoc,
} from "../provider-profile-layers.js";
import type { ProviderProfileLayer } from "../provider-profile.js";

interface ModelRule {
  readonly pattern: RegExp;
  readonly layer: ProviderProfileLayer;
}

export const MODEL_RULES: Partial<Record<ProviderId, readonly ModelRule[]>> = {
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
