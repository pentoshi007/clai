import {
  configuredPath,
  firstDefined,
  isRecord,
  knownPrompt,
  nonNegInt,
  normalizeTokenUsage,
  numericPathValue,
} from "../token-usage.js";
import type { CompatibleUsageAliases, TokenUsage } from "../token-usage.js";

export type UsageCounter = keyof CompatibleUsageAliases;

const OPENAI_USAGE_PATHS: Readonly<Record<UsageCounter, readonly string[]>> = {
  promptTokens: [
    "prompt_tokens",
    "promptTokens",
    "input_tokens",
    "inputTokens",
  ],
  completionTokens: [
    "completion_tokens",
    "completionTokens",
    "output_tokens",
    "outputTokens",
  ],
  totalTokens: ["total_tokens", "totalTokens"],
  cachedPromptTokens: [
    "prompt_tokens_details.cached_tokens",
    "promptTokensDetails.cachedTokens",
    "input_tokens_details.cached_tokens",
    "inputTokensDetails.cachedTokens",
    "cached_prompt_tokens",
    "cachedPromptTokens",
    "cached_tokens",
    "cachedTokens",
    "cache_read_input_tokens",
    "cacheReadInputTokens",
    "cache_read_tokens",
    "cacheReadTokens",
    "prompt_cache_hit_tokens",
    "promptCacheHitTokens",
  ],
  cacheCreationTokens: [
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
    "cache_write_input_tokens",
    "cacheWriteInputTokens",
    "cache_write_tokens",
    "cacheWriteTokens",
    "prompt_tokens_details.cache_write_tokens",
    "promptTokensDetails.cacheWriteTokens",
    "input_tokens_details.cache_write_tokens",
    "inputTokensDetails.cacheWriteTokens",
    "prompt_tokens_details.cache_creation_tokens",
    "promptTokensDetails.cacheCreationTokens",
  ],
  uncachedPromptTokens: [
    "prompt_cache_miss_tokens",
    "promptCacheMissTokens",
    "uncached_prompt_tokens",
    "uncachedPromptTokens",
  ],
  reasoningTokens: [
    "completion_tokens_details.reasoning_tokens",
    "completionTokensDetails.reasoningTokens",
    "output_tokens_details.reasoning_tokens",
    "outputTokensDetails.reasoningTokens",
    "reasoning_tokens",
    "reasoningTokens",
  ],
};

const FIREWORKS_PERFORMANCE_PATHS: Readonly<
  Record<UsageCounter, readonly string[]>
> = {
  promptTokens: ["prompt-tokens", "prompt_tokens", "promptTokens"],
  completionTokens: [],
  totalTokens: [],
  cachedPromptTokens: [
    "cached-prompt-tokens",
    "cached_prompt_tokens",
    "cachedPromptTokens",
  ],
  cacheCreationTokens: [],
  uncachedPromptTokens: [
    "uncached-prompt-tokens",
    "uncached_prompt_tokens",
    "uncachedPromptTokens",
  ],
  reasoningTokens: [],
};

function counterFromPaths(
  raw: unknown,
  counter: UsageCounter,
  defaults: Readonly<Record<UsageCounter, readonly string[]>>,
  aliases?: CompatibleUsageAliases | undefined,
): number | undefined {
  const configured = configuredPath(aliases, counter);
  const paths = configured
    ? [configured, ...defaults[counter]]
    : defaults[counter];
  for (const path of paths) {
    const value = numericPathValue(raw, path);
    if (value !== undefined) return value;
  }
  return undefined;
}

function mergeProviderUsage(
  usages: readonly (TokenUsage | undefined)[],
  deriveUncachedFromPrompt = false,
): TokenUsage | undefined {
  const available = usages.filter(
    (usage): usage is TokenUsage => usage !== undefined,
  );
  if (available.length === 0) return undefined;

  const promptUsage = available.find(knownPrompt);
  const promptTokens = promptUsage?.promptTokens;
  const completionTokens = available[0]!.completionTokens;
  const cachedPromptTokens = firstDefined(
    available.map((usage) => usage.cachedPromptTokens),
  );
  const cacheCreationTokens = firstDefined(
    available.map((usage) => usage.cacheCreationTokens),
  );
  const reportedUncached = firstDefined(
    available.map((usage) => usage.uncachedPromptTokens),
  );
  const uncachedPromptTokens =
    reportedUncached ??
    (deriveUncachedFromPrompt &&
    promptTokens !== undefined &&
    cachedPromptTokens !== undefined
      ? Math.max(0, promptTokens - cachedPromptTokens)
      : undefined);
  const reasoningTokens = firstDefined(
    available.map((usage) => usage.reasoningTokens),
  );
  const reasoningObserved = available.some((usage) => usage.reasoningObserved);

  return normalizeTokenUsage({
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    completionTokens,
    totalTokens:
      promptTokens !== undefined
        ? promptTokens + completionTokens
        : available[0]!.totalTokens,
    exact: available.every((usage) => usage.exact),
    ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(uncachedPromptTokens !== undefined ? { uncachedPromptTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(reasoningObserved ? { reasoningObserved: true } : {}),
  });
}

/**
 * Parse OpenAI-compatible `usage` object (stream final chunk or complete body).
 * Handles standard counters, documented DeepSeek cache hit/miss fields, and
 * optional configured aliases for a user-defined compatible endpoint.
 */
export function parseOpenAiUsage(
  raw: unknown,
  aliases?: CompatibleUsageAliases | undefined,
): TokenUsage | undefined {
  if (!isRecord(raw)) return undefined;
  return normalizeTokenUsage({
    promptTokens: counterFromPaths(
      raw,
      "promptTokens",
      OPENAI_USAGE_PATHS,
      aliases,
    ),
    completionTokens: counterFromPaths(
      raw,
      "completionTokens",
      OPENAI_USAGE_PATHS,
      aliases,
    ),
    totalTokens: counterFromPaths(
      raw,
      "totalTokens",
      OPENAI_USAGE_PATHS,
      aliases,
    ),
    cachedPromptTokens: counterFromPaths(
      raw,
      "cachedPromptTokens",
      OPENAI_USAGE_PATHS,
      aliases,
    ),
    cacheCreationTokens: counterFromPaths(
      raw,
      "cacheCreationTokens",
      OPENAI_USAGE_PATHS,
      aliases,
    ),
    uncachedPromptTokens: counterFromPaths(
      raw,
      "uncachedPromptTokens",
      OPENAI_USAGE_PATHS,
      aliases,
    ),
    reasoningTokens: counterFromPaths(
      raw,
      "reasoningTokens",
      OPENAI_USAGE_PATHS,
      aliases,
    ),
    exact: true,
  });
}

function headerCounter(
  headers: Headers | undefined,
  name: string,
): number | undefined {
  if (!headers) return undefined;
  const value = headers.get(name);
  if (value === null || !value.trim()) return undefined;
  return nonNegInt(Number(value));
}

/**
 * Fireworks emits normal compatible usage plus optional performance metrics.
 * The latter are available in response headers for complete calls and in the
 * final body frame when `perf_metrics_in_response` is requested for streams.
 */
export function parseFireworksUsage(
  rawUsage: unknown,
  performanceMetrics?: unknown,
  headers?: Headers | undefined,
): TokenUsage | undefined {
  const headerUsage = normalizeTokenUsage({
    promptTokens: headerCounter(headers, "fireworks-prompt-tokens"),
    cachedPromptTokens: headerCounter(
      headers,
      "fireworks-cached-prompt-tokens",
    ),
    exact: true,
  });
  const performanceUsage = isRecord(performanceMetrics)
    ? normalizeTokenUsage({
        promptTokens: counterFromPaths(
          performanceMetrics,
          "promptTokens",
          FIREWORKS_PERFORMANCE_PATHS,
        ),
        cachedPromptTokens: counterFromPaths(
          performanceMetrics,
          "cachedPromptTokens",
          FIREWORKS_PERFORMANCE_PATHS,
        ),
        uncachedPromptTokens: counterFromPaths(
          performanceMetrics,
          "uncachedPromptTokens",
          FIREWORKS_PERFORMANCE_PATHS,
        ),
        exact: true,
      })
    : undefined;
  return mergeProviderUsage(
    [parseOpenAiUsage(rawUsage), performanceUsage, headerUsage],
    true,
  );
}

/** Anthropic message usage: input_tokens / output_tokens. */
export function parseAnthropicUsage(raw: unknown): TokenUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const input = nonNegInt(raw.input_tokens);
  const cacheRead = nonNegInt(raw.cache_read_input_tokens);
  const cacheCreate = nonNegInt(raw.cache_creation_input_tokens);
  const promptKnown =
    input !== undefined || cacheRead !== undefined || cacheCreate !== undefined;
  const prompt = (input ?? 0) + (cacheRead ?? 0) + (cacheCreate ?? 0);
  return normalizeTokenUsage({
    ...(promptKnown ? { promptTokens: prompt } : {}),
    completionTokens: nonNegInt(raw.output_tokens),
    ...(cacheRead !== undefined ? { cachedPromptTokens: cacheRead } : {}),
    ...(cacheCreate !== undefined ? { cacheCreationTokens: cacheCreate } : {}),
    exact: true,
  });
}

/**
 * Merge Anthropic streaming usage without losing cache telemetry.
 * `message_start` carries input/cache counts while `message_delta` normally
 * carries only output tokens; replacing the former with the latter made real
 * cache hits appear as zero in the UI and audit log.
 */
export function mergeAnthropicStreamUsage(
  previous: TokenUsage | undefined,
  current: TokenUsage,
): TokenUsage {
  const promptSource = knownPrompt(current)
    ? current
    : knownPrompt(previous)
      ? previous
      : undefined;
  const promptTokens = promptSource?.promptTokens;
  const completionTokens =
    current.completionTokens || previous?.completionTokens || 0;
  const cachedPromptTokens =
    previous?.cachedPromptTokens ?? current.cachedPromptTokens;
  const cacheCreationTokens =
    previous?.cacheCreationTokens ?? current.cacheCreationTokens;
  const uncachedPromptTokens =
    previous?.uncachedPromptTokens ?? current.uncachedPromptTokens;
  const reasoningTokens = current.reasoningTokens ?? previous?.reasoningTokens;
  return normalizeTokenUsage({
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    completionTokens,
    totalTokens: (promptTokens ?? 0) + completionTokens,
    exact: true,
    ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(uncachedPromptTokens !== undefined ? { uncachedPromptTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  })!;
}

/** Gemini usageMetadata. */
export function parseGeminiUsage(raw: unknown): TokenUsage | undefined {
  if (!isRecord(raw)) return undefined;
  return normalizeTokenUsage({
    promptTokens:
      nonNegInt(raw.promptTokenCount) ?? nonNegInt(raw.prompt_token_count),
    completionTokens:
      nonNegInt(raw.candidatesTokenCount) ??
      nonNegInt(raw.candidates_token_count),
    totalTokens:
      nonNegInt(raw.totalTokenCount) ?? nonNegInt(raw.total_token_count),
    cachedPromptTokens:
      nonNegInt(raw.cachedContentTokenCount) ??
      nonNegInt(raw.cached_content_token_count),
    reasoningTokens:
      nonNegInt(raw.thoughtsTokenCount) ?? nonNegInt(raw.thoughts_token_count),
    exact: true,
  });
}

/** Ollama generate/chat counts. */
export function parseOllamaUsage(raw: {
  prompt_eval_count?: number | undefined;
  eval_count?: number | undefined;
}): TokenUsage | undefined {
  return normalizeTokenUsage({
    promptTokens: raw.prompt_eval_count,
    completionTokens: raw.eval_count,
    exact: true,
  });
}
