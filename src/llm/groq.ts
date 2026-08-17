import type { CompletionRequest, CompletionResult } from "../types.js";
import {
  defaultModels,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import {
  openAiCompatibleComplete,
  openAiCompatiblePing,
  openAiCompatibleStream,
  toCompletionResult,
  readJson,
  ingestOpenAiModelCatalog,
} from "./http.js";

const baseUrl = "https://api.groq.com/openai/v1";

export const groqFallbackModels = [
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-safeguard-20b",
  "qwen/qwen3-32b",
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "groq/compound-mini",
  "groq/compound",
];


const groqInputTokenBudgets: Array<{ pattern: RegExp; tokens: number }> = [
  { pattern: /qwen\/qwen3-32b/i, tokens: 5_500 },
  { pattern: /openai\/gpt-oss-20b/i, tokens: 7_500 },
];

export function groqInputTokenBudget(model: string): number | undefined {
  return groqInputTokenBudgets.find(({ pattern }) => pattern.test(model))
    ?.tokens;
}

let cachedModels: string[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour cache TTL

/**
 * Smallest completion allowance that can still produce a visible answer or a
 * closed tool-call JSON once reasoning tokens are billed against the same
 * Budget. The TPM guard below may never drop under this on a step
 * that carries tools or reasoning.
 */
export const GROQ_VIABLE_COMPLETION_TOKENS = 8_192;

/**
 * Groq bills reasoning against the completion allowance, and the shipped
 * per-model TPM guard (1024/2048) used to be applied with a hard `Math.min`
 * against the caller's budget — so a tool step that asked for 24 576 tokens got
 * 1024 and finished with `length` before the tool JSON closed.
 *
 * The guard is kept as the *default* for plain chat, but a step that attaches
 * tools or enables reasoning is never clamped below a viable floor.
 */
export function groqMaxTokens(
  model: string,
  requested: number | undefined,
  options?: { toolsAttached?: boolean; reasoningEnabled?: boolean },
): number | undefined {
  const m = model.toLowerCase();
  const cap = /openai\/gpt-oss-120b/.test(m)
    ? 1_024
    : /openai\/gpt-oss-20b|qwen\/qwen3-32b/.test(m)
      ? 2_048
      : undefined;
  if (!cap) return requested;
  const needsViableFloor = Boolean(
    options?.toolsAttached || options?.reasoningEnabled,
  );
  const effectiveCap = needsViableFloor
    ? Math.max(cap, GROQ_VIABLE_COMPLETION_TOKENS)
    : cap;
  return Math.min(requested ?? effectiveCap, effectiveCap);
}

export const groqProvider: LlmProvider = {
  id: "groq",
  reasoningStyle: "groq",
  displayName: "Groq",
  defaultModel: defaultModels.groq,
  envVar: "GROQ_API_KEY",
  validateKey: (key: string) => /^gsk_[A-Za-z0-9_-]{8,}$/.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    if (!auth.apiKey) {
      return groqFallbackModels;
    }
    const now = Date.now();
    if (cachedModels && now - lastFetchTime < CACHE_TTL_MS) {
      return cachedModels;
    }
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: {
          authorization: `Bearer ${auth.apiKey}`,
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const data = await readJson<{ data?: Array<{ id: string }> }>(response);
      const models = ingestOpenAiModelCatalog("groq", data);
      if (models.length > 0) {
        cachedModels = models;
        lastFetchTime = now;
        return models;
      }
      return groqFallbackModels;
    } catch {
      return groqFallbackModels;
    }
  },
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("Groq API key is required");
    await openAiCompatiblePing(baseUrl, auth.apiKey);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Groq API key is required");
    const model = request.model ?? defaultModels.groq;
    const payload = await openAiCompatibleComplete({
      provider: "Groq",
      providerId: "groq",
      baseUrl,
      apiKey: auth.apiKey,
      model,
      messages: request.messages,
      maxTokens: groqMaxTokens(model, request.maxTokens, {
        toolsAttached: Boolean(request.tools?.length),
        reasoningEnabled: Boolean(request.thinking?.enabled),
      }),
      temperature: request.temperature,
      signal: request.signal,
      reasoning: request.thinking,
      reasoningStyle: "groq",
      tools: request.tools,
      toolChoice: request.toolChoice,
      parallelToolCalls: request.parallelToolCalls,
      reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
    });
    return toCompletionResult("groq", model, payload);
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Groq API key is required");
    const model = request.model ?? defaultModels.groq;
    const payload = await openAiCompatibleStream({
      provider: "Groq",
      providerId: "groq",
      baseUrl,
      apiKey: auth.apiKey,
      model,
      messages: request.messages,
      maxTokens: groqMaxTokens(model, request.maxTokens, {
        toolsAttached: Boolean(request.tools?.length),
        reasoningEnabled: Boolean(request.thinking?.enabled),
      }),
      temperature: request.temperature,
      signal: request.signal,
      onToken,
      onToolCallDelta: request.onToolCallDelta,
      onStreamEvent: request.onStreamEvent,
      reasoning: request.thinking,
      reasoningStyle: "groq",
      tools: request.tools,
      toolChoice: request.toolChoice,
      parallelToolCalls: request.parallelToolCalls,
      reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
    });
    return toCompletionResult("groq", model, payload);
  },
};
