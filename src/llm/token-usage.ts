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
  /** Output / completion tokens for this response. */
  readonly completionTokens: number;
  /** Total when provided; otherwise prompt + completion. */
  readonly totalTokens: number;
  /** true when values came from the provider API (exact). */
  readonly exact: boolean;
  /** Prompt tokens served from a provider cache, when reported. */
  readonly cachedPromptTokens?: number | undefined;
  /** Prompt tokens written into a provider cache, when reported. */
  readonly cacheCreationTokens?: number | undefined;
  /** Reasoning tokens included in completion usage, when reported. */
  readonly reasoningTokens?: number | undefined;
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

/** Normalize sparse provider payloads into TokenUsage. */
export function normalizeTokenUsage(input: {
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  totalTokens?: number | undefined;
  exact?: boolean | undefined;
  cachedPromptTokens?: number | undefined;
  cacheCreationTokens?: number | undefined;
  reasoningTokens?: number | undefined;
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
  const reasoning = nonNegInt(input.reasoningTokens);
  return {
    promptTokens: p,
    completionTokens: c,
    totalTokens: total,
    exact: input.exact !== false,
    ...(cached !== undefined ? { cachedPromptTokens: cached } : {}),
    ...(cacheCreation !== undefined ? { cacheCreationTokens: cacheCreation } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
}

function nonNegInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.max(0, Math.floor(value));
  return n;
}

/**
 * Parse OpenAI-compatible `usage` object (stream final chunk or complete body).
 * Handles prompt_tokens / completion_tokens / total_tokens and camelCase aliases.
 */
export function parseOpenAiUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const u = raw as Record<string, unknown>;
  return normalizeTokenUsage({
    promptTokens:
      (u.prompt_tokens as number | undefined) ??
      (u.promptTokens as number | undefined) ??
      (u.input_tokens as number | undefined) ??
      (u.inputTokens as number | undefined),
    completionTokens:
      (u.completion_tokens as number | undefined) ??
      (u.completionTokens as number | undefined) ??
      (u.output_tokens as number | undefined) ??
      (u.outputTokens as number | undefined),
    totalTokens:
      (u.total_tokens as number | undefined) ??
      (u.totalTokens as number | undefined),
    // OpenAI, Groq, OpenRouter and DeepSeek-style gateways report cache and
    // reasoning detail here; it used to be dropped entirely.
    cachedPromptTokens: nonNegInt(
      (u.prompt_tokens_details as Record<string, unknown> | undefined)
        ?.cached_tokens,
    ),
    reasoningTokens: nonNegInt(
      (u.completion_tokens_details as Record<string, unknown> | undefined)
        ?.reasoning_tokens,
    ),
    exact: true,
  });
}

/** Anthropic message usage: input_tokens / output_tokens. */
export function parseAnthropicUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const u = raw as Record<string, unknown>;
  // Prompt caching moves most context into cache_read/creation; sum all three.
  const input = nonNegInt(u.input_tokens) ?? 0;
  const cacheRead = nonNegInt(u.cache_read_input_tokens) ?? 0;
  const cacheCreate = nonNegInt(u.cache_creation_input_tokens) ?? 0;
  const prompt = input + cacheRead + cacheCreate;
  return normalizeTokenUsage({
    promptTokens: prompt > 0 ? prompt : undefined,
    completionTokens: u.output_tokens as number | undefined,
    ...(cacheRead > 0 ? { cachedPromptTokens: cacheRead } : {}),
    ...(cacheCreate > 0 ? { cacheCreationTokens: cacheCreate } : {}),
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
  const promptTokens = previous?.promptTokens ?? current.promptTokens;
  const completionTokens =
    current.completionTokens || previous?.completionTokens || 0;
  const cachedPromptTokens =
    previous?.cachedPromptTokens ?? current.cachedPromptTokens;
  const cacheCreationTokens =
    previous?.cacheCreationTokens ?? current.cacheCreationTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    exact: true,
    ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
  };
}

/** Gemini usageMetadata. */
export function parseGeminiUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const u = raw as Record<string, unknown>;
  return normalizeTokenUsage({
    promptTokens:
      (u.promptTokenCount as number | undefined) ??
      (u.prompt_token_count as number | undefined),
    completionTokens:
      (u.candidatesTokenCount as number | undefined) ??
      (u.candidates_token_count as number | undefined),
    totalTokens:
      (u.totalTokenCount as number | undefined) ??
      (u.total_token_count as number | undefined),
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

/**
 * Known model context windows (tokens). Patterns are tested in order;
 * first match wins. Keep conservative defaults so % never under-reports fill.
 */
const CONTEXT_WINDOW_RULES: ReadonlyArray<{
  pattern: RegExp;
  tokens: number;
}> = [
  // Anthropic
  { pattern: /claude-(?:fable|mythos)-5/i, tokens: 1_000_000 },
  { pattern: /claude-(?:opus|sonnet)-5/i, tokens: 1_000_000 },
  { pattern: /claude-(?:opus|sonnet)-4\.[678]/i, tokens: 1_000_000 },
  { pattern: /claude-(?:opus|sonnet)-4/i, tokens: 200_000 },
  { pattern: /claude-haiku-4/i, tokens: 200_000 },
  { pattern: /claude-3-7/i, tokens: 200_000 },
  { pattern: /claude-3-5/i, tokens: 200_000 },
  { pattern: /claude-3/i, tokens: 200_000 },
  // OpenAI
  { pattern: /gpt-5\.[456](?:[-.]|$)/i, tokens: 1_050_000 },
  { pattern: /gpt-5/i, tokens: 400_000 },
  { pattern: /gpt-4\.1/i, tokens: 1_047_576 },
  { pattern: /gpt-4o/i, tokens: 128_000 },
  { pattern: /gpt-4-turbo/i, tokens: 128_000 },
  // Plain gpt-4 is 8k (32k for the -32k variant); the generic 128k rule below
  // used to over-size it, so no warning arrived before a hard context error.
  { pattern: /gpt-4-32k/i, tokens: 32_768 },
  { pattern: /^gpt-4(?:-\d{4})?$/i, tokens: 8_192 },
  { pattern: /gpt-4/i, tokens: 128_000 },
  { pattern: /o3/i, tokens: 200_000 },
  { pattern: /o4/i, tokens: 200_000 },
  { pattern: /o1/i, tokens: 200_000 },
  // Google — keep explicit rules ahead of the generic /gemini/i fallback, which
  // used to catch the shipped gemini-3.x default at an order of magnitude low.
  { pattern: /gemini-3/i, tokens: 1_048_576 },
  { pattern: /gemini-2\.5/i, tokens: 1_048_576 },
  { pattern: /gemini-2\.0/i, tokens: 1_048_576 },
  { pattern: /gemini-1\.5/i, tokens: 1_048_576 },
  { pattern: /gemini/i, tokens: 128_000 },
  // Meta / Groq
  { pattern: /llama-4/i, tokens: 128_000 },
  { pattern: /llama-3\.3/i, tokens: 128_000 },
  { pattern: /llama-3\.1/i, tokens: 128_000 },
  { pattern: /llama-3/i, tokens: 128_000 },
  // DeepSeek / Qwen / Kimi / GLM / etc.
  { pattern: /deepseek-v4/i, tokens: 1_000_000 },
  { pattern: /deepseek/i, tokens: 128_000 },
  { pattern: /qwen3\.7/i, tokens: 1_000_000 },
  { pattern: /qwen3\.(?:8|6|5)/i, tokens: 262_144 },
  { pattern: /qwen3/i, tokens: 128_000 },
  { pattern: /qwen2\.5/i, tokens: 128_000 },
  { pattern: /qwen/i, tokens: 128_000 },
  // Kimi-K3 is a 1M-window model. Keep this before generic Kimi/K2 rules so
  // Modal and gateway model IDs such as `moonshotai/Kimi-K3` are not clamped
  // to the legacy 128k family window.
  { pattern: /kimi-k3/i, tokens: 1_000_000 },
  { pattern: /kimi-k2/i, tokens: 256_000 },
  { pattern: /kimi/i, tokens: 128_000 },
  { pattern: /glm-?5\.2/i, tokens: 1_000_000 },
  { pattern: /glm-?5/i, tokens: 200_000 },
  { pattern: /glm-?4\.[56]/i, tokens: 200_000 },
  { pattern: /glm-?4/i, tokens: 128_000 },
  { pattern: /minimax-m3/i, tokens: 1_000_000 },
  { pattern: /minimax-m2\.7/i, tokens: 204_800 },
  { pattern: /minimax/i, tokens: 128_000 },
  { pattern: /mimo/i, tokens: 128_000 },
  { pattern: /gpt-oss/i, tokens: 128_000 },
  { pattern: /nemotron/i, tokens: 128_000 },
  { pattern: /muse-spark/i, tokens: 1_048_576 },
];

const DEFAULT_CONTEXT_WINDOW = 250_000;

/**
 * Provider-specific served windows that are smaller than the model's nominal
 * one. The `provider` argument used to be accepted and discarded, so `%` of
 * context was wrong wherever a gateway serves a truncated window.
 */
const PROVIDER_CONTEXT_OVERRIDES: Partial<
  Record<ProviderId, ReadonlyArray<{ pattern: RegExp; tokens: number }>>
> = {
  // Groq serves these two on a low TPM tier; the usable prompt is far below the
  // model's nominal window (mirrors `groqInputTokenBudget`).
  groq: [
    { pattern: /qwen\/qwen3-32b/i, tokens: 5_500 },
    { pattern: /openai\/gpt-oss-20b/i, tokens: 7_500 },
  ],
  // TokenRouter publishes the real upstream window per model id, and several
  // are far larger than the generic family rules below would guess.
  tokenrouter: [
    { pattern: /^deepseek-v4-(?:pro|flash)$/i, tokens: 1_000_000 },
    { pattern: /^minimax-m3$/i, tokens: 524_288 },
    { pattern: /^minimax-m2p7$/i, tokens: 196_608 },
    { pattern: /^kimi-k2p\d/i, tokens: 262_144 },
    { pattern: /^qwen3p\d-plus$/i, tokens: 262_144 },
    { pattern: /^glm-5p1(?:-fast)?$/i, tokens: 202_752 },
    { pattern: /^gpt-oss-120b$/i, tokens: 131_072 },
  ],
};

export function modelContextWindow(
  model: string | undefined,
  provider?: ProviderId | undefined,
): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  const overrides = provider ? PROVIDER_CONTEXT_OVERRIDES[provider] : undefined;
  if (overrides) {
    for (const rule of overrides) {
      if (rule.pattern.test(model)) return rule.tokens;
    }
  }
  for (const rule of CONTEXT_WINDOW_RULES) {
    if (rule.pattern.test(model)) return rule.tokens;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

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

/** Merge a new usage into session totals; prefer latest prompt as context fill. */
export function applyUsageToSnapshot(
  prev: ContextUsageSnapshot | undefined,
  usage: TokenUsage,
  contextLimit: number,
): ContextUsageSnapshot {
  const sessionPrompt =
    (prev?.sessionPromptTokens ?? 0) + (usage.exact ? usage.promptTokens : 0);
  const sessionCompletion =
    (prev?.sessionCompletionTokens ?? 0) +
    (usage.exact ? usage.completionTokens : 0);
  // Latest prompt_tokens is the true context fill for that request.
  const contextTokens =
    usage.promptTokens > 0
      ? usage.promptTokens
      : (prev?.contextTokens ?? usage.totalTokens);
  return {
    contextTokens,
    contextLimit,
    lastCompletionTokens: usage.completionTokens,
    sessionPromptTokens: sessionPrompt,
    sessionCompletionTokens: sessionCompletion,
    exact: usage.exact || Boolean(prev?.exact && usage.promptTokens === 0),
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
