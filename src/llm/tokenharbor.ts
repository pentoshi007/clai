import { createHash } from "node:crypto";
import type { CompletionRequest, CompletionResult } from "../types.js";
import {
  defaultModels,
  normalizeEndpointUrl,
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
import { catalogEntriesFromPayload } from "./catalog-facts.js";
import { tokenHarborBreakpointMode } from "./tokenharbor-cache.js";

export const TOKENHARBOR_DEFAULT_BASE_URL = "https://tokenharbor.ai/v1";
export const TOKENHARBOR_CACHE_CONTROL_HEADER = "X-TH-Cache-Control";

const GATEWAY_HEADERS: Readonly<Record<string, string>> = {
  [TOKENHARBOR_CACHE_CONTROL_HEADER]: "bypass",
};

const CATALOG_TTL_MS = 30 * 60 * 1000;
const NON_CHAT_MODEL_ID =
  /embed|(?:^|[-/.])image(?:[-/.]|$)|imagen|dall-e|(?:^|[-/])tts(?:[-/]|$)|whisper|transcribe|moderation|rerank|(?:^|[-/])video(?:[-/]|$)/i;

const catalogCache = new Map<string, { models: string[]; fetchedAt: number }>();

export function resetTokenHarborModelCache(): void {
  catalogCache.clear();
}

function resolveBaseUrl(auth: ProviderAuth): string {
  return normalizeEndpointUrl(auth.baseUrl ?? "") || TOKENHARBOR_DEFAULT_BASE_URL;
}

function requireKey(auth: ProviderAuth): string {
  if (!auth.apiKey) {
    throw new Error(
      "Token Harbor API key is required. Create one at https://tokenharbor.ai/dashboard/api-keys, then run `clai set tokenharbor <key>`.",
    );
  }
  return auth.apiKey;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function entryId(entry: unknown): string {
  if (typeof entry === "string") return entry.trim();
  const id = asRecord(entry)?.id;
  return typeof id === "string" ? id.trim() : "";
}

function declaredOutputModalities(entry: unknown): string[] | undefined {
  const record = asRecord(entry);
  if (!record) return undefined;
  const candidates = [
    record.output_modalities,
    record.outputModalities,
    asRecord(record.architecture)?.output_modalities,
    asRecord(record.modalities)?.output,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const modalities = candidate
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    if (modalities.length > 0) return modalities;
  }
  return undefined;
}

function servesChat(entry: unknown): boolean {
  const id = entryId(entry);
  if (!id) return false;
  const outputs = declaredOutputModalities(entry);
  if (outputs) return outputs.includes("text");
  return !NON_CHAT_MODEL_ID.test(id);
}

export function chatCapableCatalog(payload: unknown): { data: unknown[] } {
  const entries = [...catalogEntriesFromPayload(payload)];
  const chat = entries.filter(servesChat);
  return { data: chat.length > 0 ? chat : entries };
}

function catalogCacheKey(baseUrl: string, apiKey: string): string {
  return createHash("sha256").update(`${baseUrl}\n${apiKey}`).digest("hex");
}

function gatewayHeaders(): Record<string, string> {
  return { ...GATEWAY_HEADERS };
}

function chatOptions(request: CompletionRequest, auth: ProviderAuth) {
  const model = request.model ?? defaultModels.tokenharbor;
  const breakpoints = tokenHarborBreakpointMode(model);
  return {
    model,
    options: {
      provider: "Token Harbor",
      providerId: "tokenharbor" as const,
      baseUrl: resolveBaseUrl(auth),
      apiKey: requireKey(auth),
      model,
      messages: singleLeadingSystemMessages(request.messages),
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      headers: gatewayHeaders(),
      signal: request.signal,
      reasoning: request.thinking,
      reasoningStyle: "openai" as const,
      tools: request.tools,
      toolChoice: request.toolChoice,
      parallelToolCalls: request.parallelToolCalls,
      reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
      ...(breakpoints ? { ephemeralCacheBreakpoints: breakpoints } : {}),
      ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
    },
  };
}

export const tokenharborProvider: LlmProvider = {
  id: "tokenharbor",
  reasoningStyle: "openai",
  displayName: "Token Harbor",
  defaultModel: defaultModels.tokenharbor,
  envVar: "TOKENHARBOR_API_KEY",
  validateKey: (key: string) => /^thk_[A-Za-z0-9_-]{16,}$/.test(key.trim()),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    const apiKey = requireKey(auth);
    const baseUrl = resolveBaseUrl(auth);
    const cacheKey = catalogCacheKey(baseUrl, apiKey);
    const now = Date.now();
    const cached = catalogCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < CATALOG_TTL_MS) return cached.models;
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      });
      const payload = await readJson<unknown>(response);
      const models = ingestOpenAiModelCatalog(
        "tokenharbor",
        chatCapableCatalog(payload),
      );
      if (models.length > 0) {
        catalogCache.set(cacheKey, { models, fetchedAt: now });
        return models;
      }
      return cached?.models ?? models;
    } catch (error) {
      if (cached && cached.models.length > 0) return cached.models;
      throw error;
    }
  },
  async ping(auth: ProviderAuth): Promise<void> {
    await openAiCompatiblePing(resolveBaseUrl(auth), requireKey(auth));
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    const { model, options } = chatOptions(request, auth);
    const payload = await openAiCompatibleComplete(options);
    return toCompletionResult("tokenharbor", model, payload);
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    const { model, options } = chatOptions(request, auth);
    const payload = await openAiCompatibleStream({
      ...options,
      onToken,
      onToolCallDelta: request.onToolCallDelta,
      onStreamEvent: request.onStreamEvent,
    });
    return toCompletionResult("tokenharbor", model, payload);
  },
};
