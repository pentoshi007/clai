import { createHash } from "node:crypto";
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
  ingestModelCatalogEntries,
} from "./http.js";
import { fetchDashScopeModelCatalog } from "./wire/dashscope-model-catalog.js";

const baseUrl = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const modelCache = new Map<string, { models: string[]; fetchedAt: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000;

function modelId(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" ? id.trim() : "";
}

function mergeModelMetadata(
  models: readonly unknown[],
  metadata: readonly Record<string, unknown>[],
): unknown[] {
  const availableIds = new Set(models.map(modelId).filter(Boolean).map((id) => id.toLowerCase()));
  const metadataById = new Map(
    metadata
      .filter((entry) => availableIds.has(modelId(entry).toLowerCase()))
      .map((entry) => [modelId(entry).toLowerCase(), entry]),
  );
  return models.map((entry) => {
    const id = modelId(entry);
    const facts = metadataById.get(id.toLowerCase());
    if (!facts) return entry;
    const raw = entry && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)
      : {};
    return { ...raw, ...facts, id };
  });
}

export function resetQwenCloudModelCatalogCache(): void {
  modelCache.clear();
}

export const qwenCloudProvider: LlmProvider = {
  id: "qwen-cloud",
  reasoningStyle: "openai",
  displayName: "Qwen Cloud",
  defaultModel: defaultModels["qwen-cloud"],
  envVar: "DASHSCOPE_API_KEY",
  validateKey: (key: string) => /^sk-[A-Za-z0-9._-]{8,}$/.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    if (!auth.apiKey) throw new Error("Qwen Cloud API key is required");
    const cacheKey = createHash("sha256").update(auth.apiKey).digest("hex");
    const now = Date.now();
    const cached = modelCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.models;
    const response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${auth.apiKey}` },
    });
    const data = await readJson<{ data?: unknown[] }>(response);
    const listedModels = data.data ?? [];
    let metadata: Record<string, unknown>[] = [];
    try {
      metadata = await fetchDashScopeModelCatalog(auth.apiKey);
    } catch {
    }
    const models = ingestModelCatalogEntries(
      "qwen-cloud",
      mergeModelMetadata(listedModels, metadata),
    );
    if (models.length > 0) {
      modelCache.set(cacheKey, { models, fetchedAt: Date.now() });
    }
    return models;
  },
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("Qwen Cloud API key is required");
    await openAiCompatiblePing(baseUrl, auth.apiKey);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Qwen Cloud API key is required");
    const model = request.model ?? defaultModels["qwen-cloud"];
    const payload = await openAiCompatibleComplete({
      responsesFirst: true,
      provider: "Qwen Cloud",
      providerId: "qwen-cloud",
      baseUrl,
      apiKey: auth.apiKey,
      model,
      messages: request.messages,
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
    return toCompletionResult("qwen-cloud", model, payload);
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Qwen Cloud API key is required");
    const model = request.model ?? defaultModels["qwen-cloud"];
    const payload = await openAiCompatibleStream({
      responsesFirst: true,
      provider: "Qwen Cloud",
      providerId: "qwen-cloud",
      baseUrl,
      apiKey: auth.apiKey,
      model,
      messages: request.messages,
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
    return toCompletionResult("qwen-cloud", model, payload);
  },
};
