import type { ProviderId } from "../types.js";

export interface SamplingDefaults {
  temperature: number;
  topP?: number | undefined;
}

interface SamplingRule {
  pattern: RegExp;
  reasoningOnly?: boolean;
  providers?: ProviderId[];
  defaults: SamplingDefaults;
}

export const DEFAULT_SAMPLING: SamplingDefaults = { temperature: 0.2 };

const SAMPLING_RULES: SamplingRule[] = [
  {
    pattern: /minimax-m3/i,
    defaults: { temperature: 1.0, topP: 0.95 },
  },
  { pattern: /gpt-oss/i, defaults: { temperature: 1.0 } },
  {
    pattern: /qwen-?3|qwen3/i,
    reasoningOnly: true,
    defaults: { temperature: 0.6, topP: 0.95 },
  },
  {
    pattern: /deepseek-r1|deepseek-v3/i,
    reasoningOnly: true,
    defaults: { temperature: 0.6, topP: 0.95 },
  },
];

export function samplingDefaults(input: {
  provider?: ProviderId | undefined;
  model: string;
  reasoningEnabled?: boolean | undefined;
}): SamplingDefaults {
  for (const rule of SAMPLING_RULES) {
    if (rule.reasoningOnly && !input.reasoningEnabled) continue;
    if (
      rule.providers &&
      (!input.provider || !rule.providers.includes(input.provider))
    ) {
      continue;
    }
    if (rule.pattern.test(input.model)) return rule.defaults;
  }
  return DEFAULT_SAMPLING;
}

export function resolveSampling(input: {
  provider?: ProviderId | undefined;
  model: string;
  reasoningEnabled?: boolean | undefined;
  requestedTemperature?: number | undefined;
}): SamplingDefaults {
  const policy = samplingDefaults(input);
  return {
    temperature: input.requestedTemperature ?? policy.temperature,
    ...(policy.topP !== undefined ? { topP: policy.topP } : {}),
  };
}
