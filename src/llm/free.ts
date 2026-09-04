import type {
  CompletionRequest,
  CompletionResult,
  ReasoningPreference,
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
  ingestModelCatalogEntries,
  streamIdleBudgets,
  THINKING_STREAM_INITIAL_IDLE_TIMEOUT_MS,
  ProviderError,
  type ReasoningStyle,
} from "./http.js";
import { META_STREAM_TERMINAL } from "./stream-terminal.js";
import {
  mapResponsesEffort,
  responsesComplete,
  responsesReasoningSummary,
  responsesStream,
  type ResponsesDialectConfig,
} from "./responses-dialect.js";

const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const KILO_BASE_URL = "https://api.kilo.ai/api/gateway";

const FREE_REASONING_STYLE: ReasoningStyle = "openai";

const CURATED_ZEN_MODELS: readonly string[] = [
  "deepseek-v4-flash-free",
  "big-pickle",
  "mimo-v2.5-free",
  "hy3-free",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
];

const CURATED_KILO_MODELS: readonly string[] = [
  "kilo-auto/free",
  "stepfun/step-3.7-flash:free",
  "poolside/laguna-s-2.1:free",
  "tencent/hy3:free",
  "inclusionai/ling-3.0-tiny:free",
  "poolside/laguna-xs-2.1:free",
  "cohere/north-mini-code:free",
  "nvidia/nemotron-3.5-content-safety:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "openrouter/free",
];

function catalogEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const container = payload as
    | { data?: unknown; models?: unknown }
    | undefined;
  if (Array.isArray(container?.data)) return container.data;
  if (Array.isArray(container?.models)) return container.models;
  return [];
}

let kiloDynamicFreeIds = new Set<string>();

interface FreeSource {
  id: "free-1" | "free-2";
  name: string;
  baseUrl: string;
  curated: readonly string[];
  responsesApi: boolean;
  catalogFreeIds(payload: unknown): string[];
  keylessId(id: string): boolean;
  fallbackModels(): string[];
}

const zenSource: FreeSource = {
  id: "free-1",
  name: "opencode zen",
  baseUrl: ZEN_BASE_URL,
  curated: CURATED_ZEN_MODELS,
  responsesApi: false,
  catalogFreeIds(payload) {
    return ingestModelCatalogEntries("free", catalogEntries(payload)).filter(
      (id) => /free/i.test(id),
    );
  },
  keylessId(id) {
    return id.endsWith("-free") || CURATED_ZEN_MODELS.includes(id);
  },
  fallbackModels() {
    return CURATED_ZEN_MODELS.filter((id) => /free/i.test(id));
  },
};

const kiloSource: FreeSource = {
  id: "free-2",
  name: "kilo gateway",
  baseUrl: KILO_BASE_URL,
  curated: CURATED_KILO_MODELS,
  responsesApi: true,
  catalogFreeIds(payload) {
    const freeEntries = catalogEntries(payload).filter((entry) => {
      const raw = entry as { id?: unknown; isFree?: unknown };
      return raw.isFree === true || String(raw.id ?? "").includes(":free");
    });
    const ids = ingestModelCatalogEntries("free", freeEntries);
    if (ids.length > 0) {
      kiloDynamicFreeIds = new Set(ids.map((id) => id.toLowerCase()));
    }
    return ids;
  },
  keylessId(id) {
    return (
      id.endsWith(":free") ||
      id.endsWith("/free") ||
      CURATED_KILO_MODELS.includes(id) ||
      kiloDynamicFreeIds.has(id)
    );
  },
  fallbackModels() {
    return [...CURATED_KILO_MODELS];
  },
};

const sources: readonly FreeSource[] = [zenSource, kiloSource];

export function resolveFreeSource(model: string): {
  source: FreeSource;
  model: string;
} {
  const trimmed = model.trim();
  const lower = trimmed.toLowerCase();
  for (const source of sources) {
    const prefix = `${source.id}/`;
    if (lower.startsWith(prefix)) {
      return { source, model: trimmed.slice(prefix.length) };
    }
  }
  return { source: zenSource, model: trimmed };
}

export function isKeylessModel(model: string): boolean {
  const { source, model: id } = resolveFreeSource(model);
  return source.keylessId(id.trim().toLowerCase());
}

function assertModelAllowed(model: string, apiKey: string): void {
  if (apiKey || isKeylessModel(model)) return;
  const { source } = resolveFreeSource(model);
  throw new ProviderError(
    `Free (${source.name}): model "${model}" is premium and requires an API key (402). ` +
      `Pick a free model from /model (free-1/… or free-2/… ids) or set a key with: clai set free <key>`,
    402,
  );
}

const RESPONSES_DIALECT_PATTERN = /muse-spark/i;

function usesResponsesDialect(source: FreeSource, model: string): boolean {
  return source.id === "free-1" && RESPONSES_DIALECT_PATTERN.test(model);
}

function zenResponsesHeaders(
  auth: ProviderAuth,
  accept: "application/json" | "text/event-stream",
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept,
  };
  return auth.apiKey
    ? { ...headers, authorization: `Bearer ${auth.apiKey}` }
    : headers;
}

function zenReasoningPayload(
  reasoning: ReasoningPreference | undefined,
): Record<string, unknown> | undefined {
  if (!reasoning?.enabled) return undefined;
  const effort = mapResponsesEffort(reasoning.effort ?? "medium");
  return { effort, summary: responsesReasoningSummary(effort) };
}

const ZEN_RESPONSES_CONFIG: ResponsesDialectConfig = {
  baseUrl: ZEN_BASE_URL,
  providerId: "free",
  displayName: "Free (opencode zen)",
  artifactDialect: "openai-compatible",
  terminalPolicy: META_STREAM_TERMINAL,
  buildHeaders: zenResponsesHeaders,
  reasoningPayload: zenReasoningPayload,
  bodyExtras: () => ({
    store: false,
    include: ["reasoning.encrypted_content"],
  }),
};

interface ModelCache {
  models: string[];
  fetchedAt: number;
}
const modelCache = new Map<string, ModelCache>();
const CACHE_TTL_MS = 60 * 60 * 1000;

async function listSourceModels(
  source: FreeSource,
  key: string,
): Promise<string[]> {
  const cacheKey = `${source.id}:${key}`;
  const now = Date.now();
  const cached = modelCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.models;
  }
  try {
    const resp = await fetch(`${source.baseUrl}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
    });
    const data = await readJson<unknown>(resp);
    const models = source.catalogFreeIds(data);
    if (models.length > 0) {
      modelCache.set(cacheKey, { models, fetchedAt: now });
      return models;
    }
  } catch {
  }
  return source.fallbackModels();
}

export const freeProvider: LlmProvider = {
  id: "free",
  reasoningStyle: "openai",
  displayName: "Free (zen + kilo)",
  defaultModel: defaultModels.free,
  envVar: "FREE_API_KEY",
  validateKey: (key: string) => key.trim().length >= 8,
  async listModels(auth: ProviderAuth): Promise<string[]> {
    const key = auth.apiKey ?? "";
    const perSource = await Promise.all(
      sources.map((source) => listSourceModels(source, key)),
    );
    return perSource.flatMap((ids, index) => {
      const source = sources[index]!;
      return ids.map((id) => `${source.id}/${id}`);
    });
  },
  async ping(auth: ProviderAuth): Promise<void> {
    const key = auth.apiKey ?? "";
    const results = await Promise.allSettled(
      sources.map((source) => openAiCompatiblePing(source.baseUrl, key)),
    );
    if (results.some((result) => result.status === "fulfilled")) return;
    const first = results[0];
    throw first && first.status === "rejected"
      ? first.reason
      : new Error("Free provider ping failed");
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    const apiKey = auth.apiKey ?? "";
    const requested = request.model ?? defaultModels.free;
    assertModelAllowed(requested, apiKey);
    const { source, model } = resolveFreeSource(requested);
    if (usesResponsesDialect(source, model)) {
      const result = await responsesComplete(
        ZEN_RESPONSES_CONFIG,
        request,
        auth,
        model,
      );
      return { ...result, model: requested };
    }
    const payload = await openAiCompatibleComplete({
      responsesFirst: source.responsesApi,
      provider: "Free",
      providerId: "free",
      baseUrl: source.baseUrl,
      apiKey,
      model,
      messages: request.messages,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      signal: request.signal,
      reasoning: request.thinking,
      reasoningStyle: FREE_REASONING_STYLE,
      tools: request.tools,
      toolChoice: request.toolChoice,
      parallelToolCalls: request.parallelToolCalls,
      reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
      ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
    });
    return toCompletionResult("free", requested, payload);
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    const apiKey = auth.apiKey ?? "";
    const requested = request.model ?? defaultModels.free;
    assertModelAllowed(requested, apiKey);
    const { source, model } = resolveFreeSource(requested);
    if (usesResponsesDialect(source, model)) {
      const result = await responsesStream(
        ZEN_RESPONSES_CONFIG,
        request,
        auth,
        onToken,
        model,
      );
      return { ...result, model: requested };
    }
    const budgets = streamIdleBudgets(Boolean(request.thinking?.enabled));
    const payload = await openAiCompatibleStream({
      responsesFirst: source.responsesApi,
      provider: "Free",
      providerId: "free",
      baseUrl: source.baseUrl,
      apiKey,
      model,
      messages: request.messages,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      signal: request.signal,
      onToken,
      onToolCallDelta: request.onToolCallDelta,
      onStreamEvent: request.onStreamEvent,
      reasoning: request.thinking,
      reasoningStyle: FREE_REASONING_STYLE,
      idleTimeoutMs: budgets.idleTimeoutMs,
      initialIdleTimeoutMs: request.thinking?.enabled
        ? THINKING_STREAM_INITIAL_IDLE_TIMEOUT_MS
        : 60_000,
      outputIdleTimeoutMs: budgets.outputIdleTimeoutMs,
      tools: request.tools,
      toolChoice: request.toolChoice,
      parallelToolCalls: request.parallelToolCalls,
      reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
      ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
    });
    return toCompletionResult("free", requested, payload);
  },
};
