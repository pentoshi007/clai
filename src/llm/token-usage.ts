
import type { ProviderId } from "../types.js";
import { estimateMessagesTokens } from "../agent/context-manager.js";
import type { ChatMessage } from "../types.js";

export interface TokenUsage {
  readonly promptTokens: number;
  readonly promptTokensKnown?: false | undefined;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly exact: boolean;
  readonly cachedPromptTokens?: number | undefined;
  readonly cacheCreationTokens?: number | undefined;
  readonly uncachedPromptTokens?: number | undefined;
  readonly reasoningTokens?: number | undefined;
  readonly reasoningObserved?: true | undefined;
}

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
  readonly contextTokens: number;
  readonly contextLimit: number;
  readonly lastCompletionTokens: number;
  readonly sessionPromptTokens: number;
  readonly sessionCompletionTokens: number;
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
    exact: false,
  };
}
