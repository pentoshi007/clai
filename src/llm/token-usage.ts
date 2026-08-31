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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function nonNegInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

export function numericPathValue(
  raw: unknown,
  path: string,
): number | undefined {
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

export function configuredPath(
  aliases: CompatibleUsageAliases | undefined,
  counter: UsageCounter,
): string | undefined {
  const value = aliases?.[counter];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function knownPrompt(
  usage: TokenUsage | undefined,
): usage is TokenUsage {
  return usage !== undefined && usage.promptTokensKnown !== false;
}

export function firstDefined<T>(
  values: readonly (T | undefined)[],
): T | undefined {
  return values.find((value): value is T => value !== undefined);
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
    ...(cacheCreation !== undefined
      ? { cacheCreationTokens: cacheCreation }
      : {}),
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
import { UsageCounter } from "./usage/provider-parsers.js";
export {
  mergeAnthropicStreamUsage,
  parseAnthropicUsage,
  parseFireworksUsage,
  parseGeminiUsage,
  parseOllamaUsage,
  parseOpenAiUsage,
} from "./usage/provider-parsers.js";
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
  const percent = Math.min(
    999,
    Math.round((snapshot.contextTokens / limit) * 100),
  );
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
