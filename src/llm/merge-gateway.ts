import type { CompletionRequest, CompletionResult } from "../types.js";
import {
  defaultModels,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import { singleLeadingSystemMessages } from "./system-messages.js";
import {
  ingestOpenAiModelCatalog,
  openAiCompatibleComplete,
  openAiCompatiblePing,
  openAiCompatibleStream,
  readJson,
  toCompletionResult,
} from "./http.js";

const GATEWAY_ROOT = "https://api-gateway.merge.dev/v1";

export const mergeGatewayBaseUrl = `${GATEWAY_ROOT}/openai`;

export const mergeGatewayFallbackModels = [
  "openai/gpt-5.2",
  "openai/gpt-5.2-mini",
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "openai/o4-mini",
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-opus-4-6",
  "anthropic/claude-3-5-haiku-20241022",
  "google/gemini-3.5-flash",
  "google/gemini-2.0-flash",
  "google/gemini-2.5-pro",
  "deepseek/deepseek-chat",
  "deepseek/deepseek-reasoner",
  "meta/llama-3.3-70b-instruct",
  "mistral/mistral-large-latest",
];

const NON_CHAT_MODEL =
  /embed|image|imagen|dall-e|tts|whisper|video|moderation|rerank|transcribe/i;

interface MergeModelEntry {
  id?: unknown;
  object?: unknown;
  supported_endpoint_types?: unknown;
  capabilities?: unknown;
}

function entriesFrom(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const container = payload as { data?: unknown; models?: unknown } | undefined;
  if (Array.isArray(container?.data)) return container.data;
  if (Array.isArray(container?.models)) return container.models;
  return [];
}

function supportsChat(entry: MergeModelEntry): boolean {
  const endpoints = entry.supported_endpoint_types;
  if (Array.isArray(endpoints) && endpoints.length > 0) {
    return endpoints.some(
      (value) =>
        typeof value === "string" &&
        (value === "openai" || value.includes("chat") || value.includes("responses")),
    );
  }
  return true;
}

function chatModelsFromCatalog(payload: unknown): unknown[] {
  return entriesFrom(payload).filter((entry) => {
    if (typeof entry === "string") return !NON_CHAT_MODEL.test(entry);
    const item = entry as MergeModelEntry;
    const id = typeof item.id === "string" ? item.id : "";
    if (!id || NON_CHAT_MODEL.test(id)) return false;
    return supportsChat(item);
  });
}

let cachedModels: string[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

export function resetMergeGatewayCatalogCache(): void {
  cachedModels = null;
  lastFetchTime = 0;
}

export function mergeGatewayAuthHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}`, "x-api-key": apiKey };
}

function requireKey(auth: ProviderAuth): string {
  if (!auth.apiKey) throw new Error("Merge Gateway API key is required");
  return auth.apiKey;
}

async function fetchCatalog(apiKey: string, signal?: AbortSignal): Promise<string[]> {
  const response = await fetch(`${mergeGatewayBaseUrl}/models`, {
    headers: mergeGatewayAuthHeaders(apiKey),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await readJson<{ data?: MergeModelEntry[] }>(response);
  return ingestOpenAiModelCatalog("merge-gateway", chatModelsFromCatalog(data));
}

export const mergeGatewayProvider: LlmProvider = {
  id: "merge-gateway",
  reasoningStyle: "openai",
  displayName: "Merge Gateway",
  defaultModel: defaultModels["merge-gateway"],
  envVar: "MERGE_GATEWAY_API_KEY",
  validateKey: (key: string) => /^mg_[A-Za-z0-9_-]{8,}$/.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    const now = Date.now();
    if (cachedModels && now - lastFetchTime < CACHE_TTL_MS) return cachedModels;
    if (!auth.apiKey) return cachedModels ?? mergeGatewayFallbackModels;
    try {
      const models = await fetchCatalog(auth.apiKey);
      if (models.length > 0) {
        cachedModels = models;
        lastFetchTime = now;
        return models;
      }
      return cachedModels ?? mergeGatewayFallbackModels;
    } catch {
      return cachedModels ?? mergeGatewayFallbackModels;
    }
  },
  async ping(auth: ProviderAuth): Promise<void> {
    await openAiCompatiblePing(mergeGatewayBaseUrl, requireKey(auth));
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    const apiKey = requireKey(auth);
    const model = request.model ?? defaultModels["merge-gateway"];
    const payload = await openAiCompatibleComplete({
      provider: "Merge Gateway",
      providerId: "merge-gateway",
      baseUrl: mergeGatewayBaseUrl,
      apiKey,
      model,
      messages: singleLeadingSystemMessages(request.messages),
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      signal: request.signal,
      reasoning: request.thinking,
      reasoningStyle: "openai",
      tools: request.tools,
      toolChoice: request.toolChoice,
      parallelToolCalls: request.parallelToolCalls,
      reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
      ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
    });
    return toCompletionResult("merge-gateway", model, payload);
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    const apiKey = requireKey(auth);
    const model = request.model ?? defaultModels["merge-gateway"];
    const payload = await openAiCompatibleStream({
      provider: "Merge Gateway",
      providerId: "merge-gateway",
      baseUrl: mergeGatewayBaseUrl,
      apiKey,
      model,
      messages: singleLeadingSystemMessages(request.messages),
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      signal: request.signal,
      onToken,
      onToolCallDelta: request.onToolCallDelta,
      onStreamEvent: request.onStreamEvent,
      reasoning: request.thinking,
      reasoningStyle: "openai",
      tools: request.tools,
      toolChoice: request.toolChoice,
      parallelToolCalls: request.parallelToolCalls,
      reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
      ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
    });
    return toCompletionResult("merge-gateway", model, payload);
  },
};
