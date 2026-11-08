import { createHash } from "node:crypto";
import type {
  CompletionRequest,
  CompletionResult,
  ProviderId,
} from "../types.js";
import { catalogEntriesFromPayload } from "./catalog-facts.js";
import {
  ProviderError,
  ingestModelCatalogEntries,
  openAiCompatibleComplete,
  openAiCompatibleStream,
  readJson,
  toCompletionResult,
} from "./http.js";
import { modelListCache } from "./model-list-cache.js";
import {
  defaultModels,
  normalizeEndpointUrl,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import { singleLeadingSystemMessages } from "./system-messages.js";
import type { EphemeralCacheBreakpointMode } from "./wire/chat-body.js";

export const NON_CHAT_MODEL_ID =
  /embed|(?:^|[-/.])image(?:[-/.]|$)|imagen|dall-e|(?:^|[-/])tts(?:[-/]|$)|whisper|transcribe|moderation|rerank|(?:^|[-/])video(?:[-/]|$)/i;

const CATALOG_TIMEOUT_MS = 20_000;

export function catalogRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export interface CatalogProviderSpec {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly envVar: string;
  readonly defaultBaseUrl: string;
  readonly keyHelp: string;
  readonly validateKey: (key: string) => boolean;
  readonly catalogUrl?: ((baseUrl: string) => string) | undefined;
  readonly catalogEntries?:
    | ((payload: unknown) => readonly unknown[])
    | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly breakpointMode?:
    | ((model: string) => EphemeralCacheBreakpointMode | undefined)
    | undefined;
}

export interface CatalogProviderHandle {
  readonly provider: LlmProvider;
  resetModelCatalog(): void;
}

function isAuthRejection(error: unknown): boolean {
  return (
    error instanceof ProviderError &&
    (error.status === 401 || error.status === 403)
  );
}

export function createCatalogProvider(
  spec: CatalogProviderSpec,
): CatalogProviderHandle {
  const catalogCache = modelListCache(spec.id);
  const defaultModel = defaultModels[spec.id];

  function resolveBaseUrl(auth: ProviderAuth): string {
    return normalizeEndpointUrl(auth.baseUrl ?? "") || spec.defaultBaseUrl;
  }

  function requireKey(auth: ProviderAuth): string {
    if (!auth.apiKey) {
      throw new Error(
        `${spec.displayName} API key is required. ${spec.keyHelp}`,
      );
    }
    return auth.apiKey;
  }

  function catalogUrl(baseUrl: string): string {
    return spec.catalogUrl ? spec.catalogUrl(baseUrl) : `${baseUrl}/models`;
  }

  function catalogCacheKey(baseUrl: string, apiKey: string | undefined): string {
    return createHash("sha256")
      .update(`${baseUrl}\n${apiKey ?? ""}`)
      .digest("hex");
  }

  async function fetchCatalog(auth: ProviderAuth): Promise<unknown> {
    const response = await fetch(catalogUrl(resolveBaseUrl(auth)), {
      headers: {
        accept: "application/json",
        ...(auth.apiKey ? { authorization: `Bearer ${auth.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    return readJson<unknown>(response);
  }

  async function listModels(auth: ProviderAuth): Promise<string[]> {
    const cacheKey = catalogCacheKey(resolveBaseUrl(auth), auth.apiKey);
    const fresh = catalogCache.fresh(cacheKey);
    if (fresh) return fresh;
    const previous = catalogCache.stale(cacheKey);
    try {
      const payload = await fetchCatalog(auth);
      const entries = spec.catalogEntries
        ? spec.catalogEntries(payload)
        : catalogEntriesFromPayload(payload);
      const models = ingestModelCatalogEntries(spec.id, entries);
      catalogCache.store(models, cacheKey);
      return models.length > 0 ? models : previous ?? models;
    } catch (error) {
      if (previous && !isAuthRejection(error)) return previous;
      throw error;
    }
  }

  function chatOptions(request: CompletionRequest, auth: ProviderAuth) {
    const model = request.model ?? defaultModel;
    const breakpoints = spec.breakpointMode?.(model);
    return {
      model,
      options: {
        provider: spec.displayName,
        providerId: spec.id,
        baseUrl: resolveBaseUrl(auth),
        apiKey: requireKey(auth),
        model,
        messages: singleLeadingSystemMessages(request.messages),
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        signal: request.signal,
        reasoning: request.thinking,
        reasoningStyle: "openai" as const,
        tools: request.tools,
        toolChoice: request.toolChoice,
        parallelToolCalls: request.parallelToolCalls,
        reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
        purpose: request.purpose,
        ...(spec.headers ? { headers: { ...spec.headers } } : {}),
        ...(breakpoints ? { ephemeralCacheBreakpoints: breakpoints } : {}),
        ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
      },
    };
  }

  const provider: LlmProvider = {
    id: spec.id,
    reasoningStyle: "openai",
    displayName: spec.displayName,
    defaultModel,
    envVar: spec.envVar,
    validateKey: spec.validateKey,
    listModels,
    async ping(auth: ProviderAuth): Promise<void> {
      requireKey(auth);
      await fetchCatalog(auth);
    },
    async complete(
      request: CompletionRequest,
      auth: ProviderAuth,
    ): Promise<CompletionResult> {
      const { model, options } = chatOptions(request, auth);
      const payload = await openAiCompatibleComplete(options);
      return toCompletionResult(spec.id, model, payload);
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
      return toCompletionResult(spec.id, model, payload);
    },
  };

  return { provider, resetModelCatalog: () => catalogCache.clear() };
}
