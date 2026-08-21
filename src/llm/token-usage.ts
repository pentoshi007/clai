/**
 * Token / context usage helpers.
 *
 * Prefer provider-reported counts (OpenAI `usage`, Anthropic `usage`, Gemini
 * `usageMetadata`, Ollama eval counts). Fall back to the same estimator used
 * by auto-compact when a provider omits usage.
 */

import type { ProviderId } from "../types.js";
import { estimateMessagesTokens } from "../agent/context-manager.js";
import type { ChatMessage } from "../types.js";

/** Authoritative or estimated token counts for one completion. */
export interface TokenUsage {
  /** Input / prompt / context tokens for this request. */
  readonly promptTokens: number;
  /**
   * Present only when the provider omitted an input measurement while still
   * reporting another counter. Absence preserves the historic API contract:
   * a supplied promptTokens value is known, including an explicit zero.
   */
  readonly promptTokensKnown?: false | undefined;
  /** Output / completion tokens for this response. */
  readonly completionTokens: number;
  /** Total when provided; otherwise prompt + completion. */
  readonly totalTokens: number;
  /** true when values came from the provider API (exact). */
  readonly exact: boolean;
  /** Prompt tokens served from a provider cache, when reported. */
  readonly cachedPromptTokens?: number | undefined;
  /** Prompt tokens written into the provider cache, when reported. */
  readonly cacheCreationTokens?: number | undefined;
  /** Prompt tokens that were explicitly not served from the provider cache. */
  readonly uncachedPromptTokens?: number | undefined;
  /** Reasoning tokens included in completion usage, when reported. */
  readonly reasoningTokens?: number | undefined;
  readonly reasoningObserved?: true | undefined;
}

/**
 * Optional response-field paths for a user-configured OpenAI-compatible route.
 * Paths are relative to that route's `usage` object. They are telemetry input
 * only: they never affect request construction or cache eligibility.
 */
export interface CompatibleUsageAliases {
  readonly promptTokens?: string | undefined;
  readonly completionTokens?: string | undefined;
  readonly totalTokens?: string | undefined;
  readonly cachedPromptTokens?: string | undefined;
  readonly cacheCreationTokens?: string | undefined;
  readonly uncachedPromptTokens?: string | undefined;
  readonly reasoningTokens?: string | undefined;
}

export interface ContextUsageSnapshot {
  /** Tokens currently filling the context window (last prompt or estimate). */
  readonly contextTokens: number;
  /** Explicit session model-window limit, or 0 when no override is set. */
  readonly contextLimit: number;
  /** Last completion output tokens (0 if unknown). */
  readonly lastCompletionTokens: number;
  /** Session cumulative prompt tokens (API only when exact). */
  readonly sessionPromptTokens: number;
  /** Session cumulative completion tokens. */
  readonly sessionCompletionTokens: number;
  /** Whether contextTokens is provider-exact. */
  readonly exact: boolean;
}

type UsageCounter = keyof CompatibleUsageAliases;

const OPENAI_USAGE_PATHS: Readonly<Record<UsageCounter, readonly string[]>> = {
  promptTokens: ["prompt_tokens", "promptTokens", "input_tokens", "inputTokens"],
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
    "prompt_cache_hit_tokens",
    "promptCacheHitTokens",
  ],
  cacheCreationTokens: [
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonNegInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function numericPathValue(raw: unknown, path: string): number | undefined {
  if (!path || !/^[A-Za-z0-9_.-]+$/.test(path)) return undefined;
  let current: unknown = raw;
  for (const segment of path.split(".")) {
    if (
      segment === "__proto__" ||
      segment === "constructor" ||
      segment === "prototype" ||
      !isRecord(current) ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return undefined;
    }
    current = current[segment];
  }
  return nonNegInt(current);
}

function configuredPath(
  aliases: CompatibleUsageAliases | undefined,
  counter: UsageCounter,
): string | undefined {
  const value = aliases?.[counter];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

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

function knownPrompt(usage: TokenUsage | undefined): usage is TokenUsage {
  return usage !== undefined && usage.promptTokensKnown !== false;
}

function firstDefined<T>(values: readonly (T | undefined)[]): T | undefined {
  return values.find((value): value is T => value !== undefined);
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

/** Normalize sparse provider payloads into TokenUsage. */
export function normalizeTokenUsage(input: {
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  totalTokens?: number | undefined;
  exact?: boolean | undefined;
  cachedPromptTokens?: number | undefined;
  cacheCreationTokens?: number | undefined;
  uncachedPromptTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  reasoningObserved?: boolean | undefined;
}): TokenUsage | undefined {
  const prompt = nonNegInt(input.promptTokens);
  const completion = nonNegInt(input.completionTokens);
  let total = nonNegInt(input.totalTokens);
  if (prompt === undefined && completion === undefined && total === undefined) {
    return undefined;
  }
  const p = prompt ?? 0;
  const c = completion ?? 0;
  if (total === undefined) total = p + c;
  const cached = nonNegInt(input.cachedPromptTokens);
  const cacheCreation = nonNegInt(input.cacheCreationTokens);
  const uncached = nonNegInt(input.uncachedPromptTokens);
  const reasoning = nonNegInt(input.reasoningTokens);
  return {
    promptTokens: p,
    ...(prompt === undefined ? { promptTokensKnown: false as const } : {}),
    completionTokens: c,
    totalTokens: total,
    exact: input.exact !== false,
    ...(cached !== undefined ? { cachedPromptTokens: cached } : {}),
    ...(cacheCreation !== undefined ? { cacheCreationTokens: cacheCreation } : {}),
    ...(uncached !== undefined ? { uncachedPromptTokens: uncached } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    ...(input.reasoningObserved ? { reasoningObserved: true as const } : {}),
  };
}

export function withReasoningObservation(
  usage: TokenUsage | undefined,
  observed: boolean,
): TokenUsage | undefined {
  if (!usage || !observed || usage.reasoningObserved) return usage;
  return { ...usage, reasoningObserved: true };
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
    promptTokens: counterFromPaths(raw, "promptTokens", OPENAI_USAGE_PATHS, aliases),
    completionTokens: counterFromPaths(
      raw,
      "completionTokens",
      OPENAI_USAGE_PATHS,
      aliases,
    ),
    totalTokens: counterFromPaths(raw, "totalTokens", OPENAI_USAGE_PATHS, aliases),
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

function headerCounter(headers: Headers | undefined, name: string): number | undefined {
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
    cachedPromptTokens: headerCounter(headers, "fireworks-cached-prompt-tokens"),
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

/** Estimated usage from message list (not billing-accurate). */
export function estimateUsageFromMessages(
  messages: readonly ChatMessage[],
): TokenUsage {
  const promptTokens = estimateMessagesTokens(messages as ChatMessage[]);
  return {
    promptTokens,
    completionTokens: 0,
    totalTokens: promptTokens,
    exact: false,
  };
}

import { modelContextWindow } from "./context-windows.js";
export {
  modelContextWindow,
  providerContextOverrideTokens,
} from "./context-windows.js";

/** Compact integer: 128450 → "128,450"; large → "128.5k" when compact. */
export function formatTokenCount(n: number, compact = false): string {
  const v = Math.max(0, Math.floor(n));
  if (!compact) return v.toLocaleString("en-US");
  if (v < 10_000) return v.toLocaleString("en-US");
  if (v < 1_000_000) {
    const k = v / 1000;
    const s = k >= 100 ? k.toFixed(0) : k >= 10 ? k.toFixed(1) : k.toFixed(1);
    return `${s.replace(/\.0$/, "")}k`;
  }
  const m = v / 1_000_000;
  return `${m >= 10 ? m.toFixed(0) : m.toFixed(1).replace(/\.0$/, "")}M`;
}

/**
 * Footer chip: current session context fill (not cumulative session billing).
 * An optional denominator is an explicit session model window, never a guessed
 * model limit or auto-compaction trigger.
 */
export function formatContextChip(
  snapshot: ContextUsageSnapshot,
  opts?: { compact?: boolean },
): string {
  const compact = opts?.compact ?? false;
  const used = formatTokenCount(snapshot.contextTokens, compact);
  const approx = snapshot.exact ? "" : "~";
  const limit = snapshot.contextLimit;
  if (!limit || limit <= 0) return `ctx:${approx}${used}`;
  const percent = Math.min(999, Math.round((snapshot.contextTokens / limit) * 100));
  const budget = formatTokenCount(limit, true);
  return compact
    ? `ctx:${approx}${used}/${budget} ${percent}%`
    : `ctx ${approx}${used}/${budget} ${percent}%`;
}

/** Merge a new usage into session totals; prefer latest known prompt as context fill. */
export function applyUsageToSnapshot(
  prev: ContextUsageSnapshot | undefined,
  usage: TokenUsage,
  contextLimit: number,
): ContextUsageSnapshot {
  const hasPromptMeasurement = usage.promptTokensKnown !== false;
  const sessionPrompt =
    (prev?.sessionPromptTokens ?? 0) +
    (usage.exact && hasPromptMeasurement ? usage.promptTokens : 0);
  const sessionCompletion =
    (prev?.sessionCompletionTokens ?? 0) +
    (usage.exact ? usage.completionTokens : 0);
  const contextTokens = hasPromptMeasurement
    ? usage.promptTokens
    : (prev?.contextTokens ?? usage.totalTokens);
  return {
    contextTokens,
    contextLimit,
    lastCompletionTokens: usage.completionTokens,
    sessionPromptTokens: sessionPrompt,
    sessionCompletionTokens: sessionCompletion,
    exact: usage.exact && hasPromptMeasurement,
  };
}

export function snapshotFromEstimate(
  messages: readonly ChatMessage[],
  model: string | undefined,
  provider?: ProviderId | undefined,
  prev?: ContextUsageSnapshot | undefined,
): ContextUsageSnapshot {
  const est = estimateUsageFromMessages(messages);
  return {
    contextTokens: est.promptTokens,
    contextLimit: modelContextWindow(model, provider),
    lastCompletionTokens: prev?.lastCompletionTokens ?? 0,
    sessionPromptTokens: prev?.sessionPromptTokens ?? 0,
    sessionCompletionTokens: prev?.sessionCompletionTokens ?? 0,
    // Keep exact:true if we previously had API context and messages unchanged
    // is hard to know — always false for pure estimate refresh.
    exact: false,
  };
}
