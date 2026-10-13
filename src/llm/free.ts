import { kiloClientHeaders, zenClientHeaders } from "./free-client.js";

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
import { parseCatalogFacts } from "./catalog-facts.js";
import { modelCatalogFacts, registerModelCatalogLimits } from "./capabilities.js";
import { withModelCatalogFacts } from "./catalog-context.js";
import { supplementZenModelLimits } from "./free-model-limits.js";
import { rememberedModelLimits } from "./model-limit-store.js";
import { META_STREAM_TERMINAL } from "./stream-terminal.js";
import {
  mapResponsesEffort,
  responsesReasoningSummary,
  responsesStream,
  type ResponsesDialectConfig,
} from "./responses-dialect.js";

const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const KILO_BASE_URL = "https://api.kilo.ai/api/gateway";

const FREE_REASONING_STYLE: ReasoningStyle = "openai";

const CURATED_ZEN_MODELS: readonly string[] = [
  "muse-spark-1.3-contributor-free",
  "muse-spark-1.2-contributor-free",
  "deepseek-v4-flash-free",
  "big-pickle",
  "mimo-v2.6-flash-free",
  "mimo-v2.5-free",
  "nemotron-3-ultra-free",
];

const CURATED_KILO_MODELS: readonly string[] = [
  "kilo-auto/free",
  "stepfun/step-3.7-flash:free",
  "poolside/laguna-s-2.1:free",
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

function catalogEntryId(entry: unknown): string {
  return parseCatalogFacts(entry)?.id ?? "";
}

let kiloDynamicFreeIds = new Set<string>();

interface FreeSource {
  id: "free-1" | "free-2";
  name: string;
  baseUrl: string;
  keylessApiKey: string;
  curated: readonly string[];
  responsesApi: boolean;
  requiredTools?: boolean;
  requestHeaders(apiKey?: string): Record<string, string>;
  catalogFreeEntries(payload: unknown): unknown[];
  keylessId(id: string): boolean;
  fallbackModels(): string[];
}

const zenSource: FreeSource = {
  id: "free-1",
  name: "opencode zen",
  baseUrl: ZEN_BASE_URL,
  keylessApiKey: "public",
  curated: CURATED_ZEN_MODELS,
  responsesApi: false,
  requiredTools: true,
  requestHeaders: zenClientHeaders,
  catalogFreeEntries(payload) {
    return catalogEntries(payload).filter((entry) => {
      const id = catalogEntryId(entry);
      return /free/i.test(id) && !/^jev(?:[-.]|$)/i.test(id);
    });
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
  keylessApiKey: "",
  curated: CURATED_KILO_MODELS,
  responsesApi: true,
  requestHeaders: kiloClientHeaders,
  catalogFreeEntries(payload) {
    const freeEntries = catalogEntries(payload).filter((entry) => {
      const raw = entry as { isFree?: unknown };
      return raw.isFree === true || catalogEntryId(entry).includes(":free");
    });
    const ids = freeEntries.map(catalogEntryId).filter(Boolean);
    if (ids.length > 0) {
      kiloDynamicFreeIds = new Set(ids.map((id) => id.toLowerCase()));
    }
    return freeEntries;
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
  throw new ProviderError(
    `Free (model=${model}): this model is premium and requires an API key (402). ` +
      `Pick a free model from /model (free-1/… or free-2/… ids) or set a key with: clai set free <key>`,
    402,
  );
}

function usesResponsesDialect(source: FreeSource, model: string): boolean {
  return source.id === "free-1" && /muse-spark/i.test(model);
}

function zenResponsesHeaders(
  auth: ProviderAuth,
  accept: "application/json" | "text/event-stream",
): Record<string, string> {
  return {
    "content-type": "application/json",
    accept,
    ...zenClientHeaders(auth.apiKey),
  };
}

function ensureRequiredTools(
  request: CompletionRequest,
  dialect: "responses" | "chat",
): CompletionRequest {
  const existingTools = request.tools ?? [];
  const hasRead = existingTools.some(
    (t) => t.name === "read" || t.wireName === "read",
  );
  const hasShell = existingTools.some(
    (t) => t.name === "shell" || t.wireName === "shell",
  );
  let tools = existingTools;
  if (!hasRead || !hasShell) {
    tools = [...existingTools];
    if (!hasRead) {
      tools.push({
        name: "read",
        wireName: "read",
        description: "Read file",
        parameters: { type: "object", properties: {} },
      });
    }
    if (!hasShell) {
      tools.push({
        name: "shell",
        wireName: "shell",
        description: "Run shell",
        parameters: { type: "object", properties: {} },
      });
    }
  }
  const suppressTools = !request.tools?.length || request.toolChoice === "none";
  if (dialect === "chat") {
    return {
      ...request,
      tools,
      toolChoice: suppressTools ? undefined : (request.toolChoice ?? "auto"),
      ...(suppressTools ? { onToolCallDelta: undefined } : {}),
    };
  }
  const toolChoice = request.toolChoice === "auto" ? "auto" : undefined;
  return {
    ...request,
    tools,
    toolChoice,
    ...(suppressTools ? { onToolCallDelta: undefined } : {}),
  };
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
  displayName: "Free",
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
  entries: readonly unknown[];
  fetchedAt: number;
}
const modelCache = new Map<string, ModelCache>();
const CACHE_TTL_MS = 30 * 60 * 1000;

function sourceScopedEntry(source: FreeSource, entry: unknown): unknown {
  const id = `${source.id}/${catalogEntryId(entry)}`;
  return entry && typeof entry === "object" ? { ...entry, id } : id;
}

async function listSourceEntries(
  source: FreeSource,
  key: string,
): Promise<readonly unknown[]> {
  const cacheKey = `${source.id}:${key}`;
  const now = Date.now();
  const cached = modelCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.entries;
  }
  try {
    const resp = await fetch(`${source.baseUrl}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
    });
    const data = await readJson<unknown>(resp);
    const entries = source
      .catalogFreeEntries(data)
      .filter((entry) => catalogEntryId(entry).length > 0);
    if (entries.length > 0) {
      modelCache.set(cacheKey, { entries, fetchedAt: now });
      return entries;
    }
  } catch {
  }
  return source.fallbackModels();
}

function withFreeModelCatalog<T>(
  source: FreeSource,
  model: string,
  operation: () => T,
): T {
  const id = `${source.id}/${model}`;
  const facts = {
    ...rememberedModelLimits("free", id),
    ...modelCatalogFacts("free", id),
    id,
  };
  return withModelCatalogFacts(
    "free",
    [
      { id, facts },
      { id: model, facts: { ...facts, id: model } },
    ],
    operation,
  );
}

async function zenResponsesCompletion(
  request: CompletionRequest,
  auth: ProviderAuth,
  model: string,
  onToken: (token: string) => void,
): Promise<CompletionResult> {
  const result = await responsesStream(
    ZEN_RESPONSES_CONFIG, ensureRequiredTools(request, "responses"), auth, onToken, model,
  );
  const suppressTools = !request.tools?.length || request.toolChoice === "none";
  return { ...result, toolCalls: suppressTools ? undefined : result.toolCalls };
}

function freeChatOptions(
  source: FreeSource,
  model: string,
  request: CompletionRequest,
  apiKey: string,
) {
  return {
    responsesFirst: source.responsesApi,
    headers: source.requestHeaders(apiKey),
    provider: "Free" as const,
    providerId: "free" as const,
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
  };
}

async function requestFreeCompletion(
  request: CompletionRequest,
  auth: ProviderAuth,
  stream: boolean,
  onToken: (token: string) => void,
): Promise<CompletionResult> {
  request.signal?.throwIfAborted();
  const apiKey = auth.apiKey ?? "";
  const requested = request.model ?? defaultModels.free;
  assertModelAllowed(requested, apiKey);
  const { source, model } = resolveFreeSource(requested);
  return withFreeModelCatalog(source, model, async () => {
    if (usesResponsesDialect(source, model)) {
      const result = await zenResponsesCompletion(request, auth, model, onToken);
      return { ...result, model: requested };
    }
    const effective = source.requiredTools ? ensureRequiredTools(request, "chat") : request;
    const options = freeChatOptions(source, model, effective, apiKey);
    const callbacks = stream
      ? { onToolCallDelta: effective.onToolCallDelta, onStreamEvent: effective.onStreamEvent }
      : {};
    const thinkingEnabled = Boolean(effective.thinking?.enabled);
    const budgets = streamIdleBudgets(thinkingEnabled);
    const payload = stream || source.id === "free-1"
      ? await openAiCompatibleStream({
          ...options,
          ...callbacks,
          onToken,
          idleTimeoutMs: budgets.idleTimeoutMs,
          initialIdleTimeoutMs: thinkingEnabled
            ? THINKING_STREAM_INITIAL_IDLE_TIMEOUT_MS : 60_000,
          outputIdleTimeoutMs: budgets.outputIdleTimeoutMs,
        })
      : await openAiCompatibleComplete(options);
    const result = toCompletionResult("free", requested, payload);
    if (result.reasoningArtifacts?.length) {
      result.reasoningArtifacts = result.reasoningArtifacts.map((art) => ({
        ...art,
        provenance: { ...art.provenance, model: requested },
      }));
    }
    return result;
  });
}

function freeRequestAuth(request: CompletionRequest, auth: ProviderAuth): ProviderAuth {
  const requested = request.model ?? defaultModels.free;
  const { source, model } = resolveFreeSource(requested);
  const keyless = source.keylessId(model.trim().toLowerCase());
  return keyless ? { ...auth, apiKey: source.keylessApiKey } : auth;
}

export const freeProvider: LlmProvider = {
  id: "free",
  reasoningStyle: "openai",
  displayName: "Free",
  defaultModel: defaultModels.free,
  envVar: "FREE_API_KEY",
  validateKey: (key: string) => key.trim().length >= 8,
  async listModels(auth: ProviderAuth): Promise<string[]> {
    const key = auth.apiKey ?? "";
    const perSource = await Promise.all(
      sources.map(async (source) => {
        const entries = await listSourceEntries(source, key);
        const enriched =
          source.id === "free-1"
            ? await supplementZenModelLimits(entries)
            : entries;
        return enriched.map((entry) => sourceScopedEntry(source, entry));
      }),
    );
    const models = ingestModelCatalogEntries("free", perSource.flat());
    registerModelCatalogLimits(
      "free",
      (perSource[0] ?? []).flatMap((entry) => {
        const facts = parseCatalogFacts(entry);
        return facts ? [{ ...facts, id: facts.id.slice("free-1/".length) }] : [];
      }),
    );
    return models;
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
    return requestFreeCompletion(request, freeRequestAuth(request, auth), false, () => undefined);
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    return requestFreeCompletion(request, freeRequestAuth(request, auth), true, onToken);
  },
};
