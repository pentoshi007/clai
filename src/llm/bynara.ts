import type {
  CompletionRequest,
  CompletionResult,
  ReasoningEffort,
} from "../types.js";
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
  streamIdleBudgets,
  THINKING_STREAM_INITIAL_IDLE_TIMEOUT_MS,
  ProviderError,
  type ReasoningStyle,
} from "./http.js";

const baseUrl = "https://router.bynara.id/v1";

const BYNARA_REASONING_STYLE: ReasoningStyle = "bynara";

function isEffortRejectedError(error: unknown): boolean {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: number }).status)
      : undefined;
  if (status !== 400 && status !== 422) return false;
  const body =
    error && typeof error === "object" && "body" in error
      ? String((error as { body?: string }).body ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  const hay = `${message}\n${body}`.toLowerCase();
  if (!/reasoning_effort|\beffort\b|chat_template_kwargs|\bthinking\b/.test(hay)) {
    return false;
  }
  return /must be one of|invalid|unsupported|not support|unknown|unrecognized|not a valid|not allowed|expected one of/.test(
    hay,
  );
}

const EFFORT_LADDER: ReasoningEffort[] = ["high", "medium", "low"];

function fallbackEffortsFor(requested: ReasoningEffort): ReasoningEffort[] {
  const normalized = requested.toLowerCase();
  const nearest: Record<string, ReasoningEffort[]> = {
    none: ["low", "medium", "high"],
    minimal: ["low", "medium", "high"],
    low: ["medium", "high"],
    medium: ["high", "low"],
    high: ["medium", "low"],
    xhigh: ["high", "medium", "low"],
    max: ["high", "medium", "low"],
  };
  const order = nearest[normalized] ?? EFFORT_LADDER;
  return order.filter((effort) => effort !== normalized);
}

function effortCandidates(
  thinking: CompletionRequest["thinking"],
): ReasoningEffort[] {
  const requested = thinking?.effort ?? "medium";
  const seen = new Set<string>();
  const candidates: ReasoningEffort[] = [];
  for (const effort of [requested, ...fallbackEffortsFor(requested)]) {
    const key = effort.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(effort);
  }
  return candidates;
}

async function withEffortFallback<T>(
  request: CompletionRequest,
  attempt: (thinking: CompletionRequest["thinking"]) => Promise<T>,
  onExhausted: () => never,
): Promise<T> {
  if (!request.thinking?.enabled) return await attempt(request.thinking);
  const candidates = effortCandidates(request.thinking);
  let lastError: unknown;
  for (let index = 0; index < candidates.length; index += 1) {
    try {
      return await attempt({ ...request.thinking, effort: candidates[index]! });
    } catch (error) {
      if (!isEffortRejectedError(error)) throw error;
      lastError = error;
      if (index === candidates.length - 1) throw error;
    }
  }
  if (lastError) throw lastError;
  onExhausted();
}

interface ModelCache {
  models: string[];
  fetchedAt: number;
}
const modelCache = new Map<string, ModelCache>();
const CACHE_TTL_MS = 60 * 60 * 1000;

export const bynaraProvider: LlmProvider = {
  id: "bynara",
  displayName: "Bynara",
  defaultModel: defaultModels.bynara,
  envVar: "BYNARA_API_KEY",
  validateKey: (key: string) => /^[A-Za-z0-9_-]{8,}$/.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    const key = auth.apiKey ?? "";
    const now = Date.now();
    const cached = modelCache.get(key);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.models;
    }
    try {
      const resp = await fetch(`${baseUrl}/models`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
      });
      const data = await readJson<{ data?: Array<{ id: string }> }>(resp);
      const models = ingestOpenAiModelCatalog("bynara", data);
      if (models.length > 0) {
        modelCache.set(key, { models, fetchedAt: now });
      }
      return models;
    } catch {
      return [];
    }
  },
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("Bynara API key is required");
    await openAiCompatiblePing(baseUrl, auth.apiKey);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    const apiKey = auth.apiKey;
    if (!apiKey) throw new Error("Bynara API key is required");
    const model = request.model ?? defaultModels.bynara;
    return await withEffortFallback(
      request,
      async (thinking) => {
        const payload = await openAiCompatibleComplete({
          provider: "Bynara",
          providerId: "bynara",
          baseUrl,
          apiKey,
          model,
          messages: request.messages,
          maxTokens: request.maxTokens,
          temperature: request.temperature,
          signal: request.signal,
          reasoning: thinking,
          reasoningStyle: BYNARA_REASONING_STYLE,
          tools: request.tools,
          toolChoice: request.toolChoice,
          parallelToolCalls: request.parallelToolCalls,
        });
        return toCompletionResult("bynara", model, payload);
      },
      () => {
        throw new ProviderError(
          `Bynara returned no completion text (model=${model}).`,
        );
      },
    );
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    const apiKey = auth.apiKey;
    if (!apiKey) throw new Error("Bynara API key is required");
    const model = request.model ?? defaultModels.bynara;
    return await withEffortFallback(
      request,
      async (thinking) => {
        const budgets = streamIdleBudgets(Boolean(thinking?.enabled));
        const payload = await openAiCompatibleStream({
          provider: "Bynara",
          providerId: "bynara",
          baseUrl,
          apiKey,
          model,
          messages: request.messages,
          maxTokens: request.maxTokens,
          temperature: request.temperature,
          signal: request.signal,
          onToken,
          onToolCallDelta: request.onToolCallDelta,
          reasoning: thinking,
          reasoningStyle: BYNARA_REASONING_STYLE,
          idleTimeoutMs: budgets.idleTimeoutMs,
          initialIdleTimeoutMs: thinking?.enabled
            ? THINKING_STREAM_INITIAL_IDLE_TIMEOUT_MS
            : 60_000,
          outputIdleTimeoutMs: budgets.outputIdleTimeoutMs,
          tools: request.tools,
          toolChoice: request.toolChoice,
          parallelToolCalls: request.parallelToolCalls,
        });
        return toCompletionResult("bynara", model, payload);
      },
      () => {
        throw new ProviderError(`Bynara stream failed (model=${model}).`);
      },
    );
  },
};
