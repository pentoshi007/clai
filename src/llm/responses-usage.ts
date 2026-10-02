import { isRecord, normalizeTokenUsage, numericPathValue, type TokenUsage } from "./token-usage.js";

export interface ResponsesUsageCounters {
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  totalTokens?: number | undefined;
  cachedPromptTokens?: number | undefined;
  cacheCreationTokens?: number | undefined;
  uncachedPromptTokens?: number | undefined;
  reasoningTokens?: number | undefined;
}

const COUNTERS = ["promptTokens", "completionTokens", "totalTokens", "cachedPromptTokens", "cacheCreationTokens", "uncachedPromptTokens", "reasoningTokens"] as const;

const PATHS: Readonly<Record<keyof ResponsesUsageCounters, readonly string[]>> = {
  promptTokens: ["input_tokens", "prompt_tokens", "inputTokens", "promptTokens"],
  completionTokens: ["output_tokens", "completion_tokens", "outputTokens", "completionTokens"],
  totalTokens: ["total_tokens", "totalTokens"],
  cachedPromptTokens: [
    "input_tokens_details.cached_tokens", "prompt_tokens_details.cached_tokens",
    "inputTokensDetails.cachedTokens", "promptTokensDetails.cachedTokens",
    "prompt_cache_hit_tokens", "cache_read_input_tokens", "cache_read_tokens",
    "cached_prompt_tokens", "cached_tokens", "cachedPromptTokens", "cachedTokens",
  ],
  cacheCreationTokens: [
    "input_tokens_details.cache_creation_tokens", "prompt_tokens_details.cache_creation_tokens",
    "input_tokens_details.cache_write_tokens", "prompt_tokens_details.cache_write_tokens",
    "inputTokensDetails.cacheCreationTokens", "promptTokensDetails.cacheCreationTokens",
    "inputTokensDetails.cacheWriteTokens", "promptTokensDetails.cacheWriteTokens",
    "cache_creation_input_tokens", "cache_write_input_tokens", "cache_write_tokens",
    "cacheCreationInputTokens", "cacheWriteInputTokens", "cacheWriteTokens", "cacheCreationTokens",
  ],
  uncachedPromptTokens: [
    "input_tokens_details.uncached_tokens", "prompt_tokens_details.uncached_tokens",
    "inputTokensDetails.uncachedTokens", "promptTokensDetails.uncachedTokens",
    "prompt_cache_miss_tokens", "uncached_prompt_tokens", "uncachedPromptTokens",
  ],
  reasoningTokens: [
    "output_tokens_details.reasoning_tokens", "completion_tokens_details.reasoning_tokens",
    "outputTokensDetails.reasoningTokens", "completionTokensDetails.reasoningTokens",
    "reasoning_tokens", "reasoningTokens",
  ],
};

function parseCounters(raw: unknown): ResponsesUsageCounters | undefined {
  if (!isRecord(raw)) return undefined;
  const counters: ResponsesUsageCounters = {};
  for (const key of COUNTERS) {
    for (const path of PATHS[key]) {
      const value = numericPathValue(raw, path);
      if (value === undefined) continue;
      counters[key] = value;
      break;
    }
  }
  return counters;
}

export function parseResponsesUsage(raw: unknown): TokenUsage | undefined {
  const counters = parseCounters(raw);
  return counters ? normalizeTokenUsage({ ...counters, exact: true }) : undefined;
}

export function mergeResponsesUsageCounters(
  previous: ResponsesUsageCounters,
  raw: unknown,
): ResponsesUsageCounters {
  const current = parseCounters(raw);
  if (!current) return previous;
  const merged = { ...previous };
  for (const key of COUNTERS) {
    if (current[key] !== undefined) merged[key] = current[key];
  }
  if (current.totalTokens === undefined &&
    (current.promptTokens !== undefined || current.completionTokens !== undefined)) {
    delete merged.totalTokens;
  }
  return merged;
}
