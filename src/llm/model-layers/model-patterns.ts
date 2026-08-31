import { providerDoc } from "../provider-profile-layers.js";
import type { ProviderProfileLayer } from "../provider-profile.js";

export const OPENROUTER_REASONING_PATTERN =
  /:thinking|deepseek-v4|deepseek-r1|qwen3|kimi-k[23]|claude-(?:opus|sonnet|haiku)-4|gpt-5|(?:^|\/)o[134]|grok.*reasoner/i;

export const QWEN3_MAX_GATEWAY_EFFORTS: ProviderProfileLayer = {
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

export const QWEN3_MAX_PATTERN = /qwen-?3\.?8-?max/i;

export const LING_PATTERN = /(?:^|[-/])ling-?3(?:[.-]|$)/i;

export const LING_NO_REASONING: ProviderProfileLayer = {
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

export const AWS_MANTLE_ANTHROPIC_MODEL =
  /(?:^|[./-])(?:anthropic|claude)(?:[./-]|$)/i;
