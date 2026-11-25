import type { CompletionRequest, CompletionResult } from "../types.js";
import {
  defaultModels,
  normalizeEndpointUrl,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import { singleLeadingSystemMessages } from "./system-messages.js";
import {
  openAiCompatibleComplete,
  openAiCompatiblePing,
  openAiCompatibleStream,
  toCompletionResult,
  readJson,
  ingestOpenAiModelCatalog,
} from "./http.js";
import { modelListCache } from "./model-list-cache.js";

export const TOKENROUTER_DEFAULT_BASE_URL = "https://api.tokenrouter.com/v1";

function resolveBaseUrl(auth: ProviderAuth): string {
  const override = normalizeEndpointUrl(auth.baseUrl ?? "");
  return override || TOKENROUTER_DEFAULT_BASE_URL;
}

const CHAT_ENDPOINT_TYPES = new Set([
  "openai",
  "openai-response",
  "anthropic",
  "anthropic-compatible",
  "gemini",
]);

interface TokenrouterCatalogEntry {
  readonly id?: string | undefined;
  readonly supported_endpoint_types?: unknown;
  readonly tags?: unknown;
}

type TokenrouterWireApi = "chat-completions" | "responses";

interface TokenrouterCatalog {
  readonly models: string[];
  readonly wireByModel: ReadonlyMap<string, TokenrouterWireApi>;
}

const modelCache = modelListCache<TokenrouterCatalog>("tokenrouter");

function catalogKey(baseUrl: string, apiKey?: string): string {
  return JSON.stringify([baseUrl, apiKey]);
}

const NON_CHAT_MODEL_ID =
  /embedding|(?:^|[-/])embed(?:[-/]|$)|(?:^|[-/])image|image(?:[-/]|$)|(?:^|[-/])tts(?:[-/]|$)|whisper/i;

function endpointTypes(entry: TokenrouterCatalogEntry): string[] {
  return Array.isArray(entry.supported_endpoint_types)
    ? entry.supported_endpoint_types.filter((value): value is string => typeof value === "string")
    : [];
}

function servesChatCompletions(entry: TokenrouterCatalogEntry): boolean {
  const id = typeof entry?.id === "string" ? entry.id : "";
  if (!id.trim() || NON_CHAT_MODEL_ID.test(id)) return false;
  const endpoints = endpointTypes(entry);
  if (endpoints.length > 0) {
    return endpoints.some((endpoint) => CHAT_ENDPOINT_TYPES.has(endpoint));
  }
  const tags = typeof entry.tags === "string" ? entry.tags : "";
  return !tags.trim() || /text/i.test(tags);
}

export function chatCapableCatalog(data: {
  data?: TokenrouterCatalogEntry[] | undefined;
}): { data: TokenrouterCatalogEntry[] } {
  const entries = Array.isArray(data.data) ? data.data : [];
  const chat = entries.filter(servesChatCompletions);
  return { data: chat.length > 0 ? chat : entries };
}

function wireApiFor(endpoints: readonly string[]): TokenrouterWireApi | undefined {
  const chat = endpoints.includes("openai");
  const responses = endpoints.includes("openai-response");
  if (chat === responses) return undefined;
  return responses ? "responses" : "chat-completions";
}

function requestOptions(request: CompletionRequest, auth: ProviderAuth) {
  const { apiKey } = auth;
  if (!apiKey) throw new Error("TokenRouter API key is required");
  const baseUrl = resolveBaseUrl(auth);
  const model = request.model ?? defaultModels.tokenrouter;
  const wireApi = modelCache.stale(catalogKey(baseUrl, apiKey))?.wireByModel.get(model);
  return {
    provider: "TokenRouter",
    providerId: "tokenrouter",
    baseUrl,
    apiKey,
    model,
    wireApi,
    responsesFirst: wireApi === undefined,
    messages: singleLeadingSystemMessages(request.messages),
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    signal: request.signal,
    purpose: request.purpose,
    reasoning: request.thinking,
    reasoningStyle: "openai",
    tools: request.tools,
    toolChoice: request.toolChoice,
    parallelToolCalls: request.parallelToolCalls,
    reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
    forceReasoningReplay: request.forceReasoningReplay,
  } as const;
}

export const tokenrouterProvider: LlmProvider = {
  id: "tokenrouter",
  reasoningStyle: "openai",
  displayName: "TokenRouter",
  defaultModel: defaultModels.tokenrouter,
  envVar: "TOKENROUTER_API_KEY",
  validateKey: (key: string) => /^[A-Za-z0-9_.-]{8,}$/.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    const baseUrl = resolveBaseUrl(auth);
    const cacheKey = catalogKey(baseUrl, auth.apiKey);
    const fresh = modelCache.fresh(cacheKey);
    if (fresh) return fresh.models;
    const previous = modelCache.stale(cacheKey)?.models;
    try {
      const headers: Record<string, string> = {};
      if (auth.apiKey) headers["authorization"] = `Bearer ${auth.apiKey}`;
      const response = await fetch(`${baseUrl}/models`, { headers });
      const data = await readJson<{ data?: TokenrouterCatalogEntry[] }>(response);
      const catalog = chatCapableCatalog(data);
      const models = ingestOpenAiModelCatalog("tokenrouter", catalog);
      if (!models.length) return previous ?? models;

      const wireByModel = new Map<string, TokenrouterWireApi>();
      for (const entry of catalog.data) {
        if (typeof entry?.id !== "string") continue;
        const wireApi = wireApiFor(endpointTypes(entry));
        if (wireApi) wireByModel.set(entry.id.trim(), wireApi);
      }
      modelCache.store({ models, wireByModel }, cacheKey);
      return models;
    } catch (err) {
      if (previous) return previous;
      throw err;
    }
  },
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("TokenRouter API key is required");
    await openAiCompatiblePing(resolveBaseUrl(auth), auth.apiKey);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    const options = requestOptions(request, auth);
    return toCompletionResult("tokenrouter", options.model, await openAiCompatibleComplete(options));
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    const options = requestOptions(request, auth);
    const payload = await openAiCompatibleStream({
      ...options,
      onToken,
      onToolCallDelta: request.onToolCallDelta,
      onStreamEvent: request.onStreamEvent,
    });
    return toCompletionResult("tokenrouter", options.model, payload);
  },
};
