import { createHash } from "node:crypto";
import type { CompletionRequest } from "../types.js";
import { registerModelCatalog } from "./capabilities.js";
import type { CatalogModel } from "./capabilities.js";
import {
  openAiCompatibleComplete,
  openAiCompatiblePing,
  openAiCompatibleStream,
  ProviderError,
  readJson,
  toCompletionResult,
} from "./http.js";
import { defaultModels, normalizeEndpointUrl } from "./provider.js";
import type { LlmProvider, ProviderAuth } from "./provider.js";
import { mistralModelCatalog } from "./wire/mistral-model-catalog.js";
import { withModelCatalogFacts } from "./catalog-context.js";

const DEFAULT_BASE_URL = "https://api.mistral.ai/v1";
const CATALOG_TTL_MS = 30 * 60 * 1000;
const MAX_CATALOG_ROUTES = 32;
const catalogs = new Map<
  string,
  { expiresAt: number; models: CatalogModel[] }
>();
const pendingCatalogs = new Map<string, Promise<CatalogModel[]>>();

function credentials(auth: ProviderAuth): { apiKey: string; baseUrl: string } {
  if (!auth.apiKey) throw new Error("Mistral API key is required");
  return {
    apiKey: auth.apiKey,
    baseUrl: normalizeEndpointUrl(
      auth.baseUrl ?? process.env.MISTRAL_BASE_URL ?? DEFAULT_BASE_URL,
    ),
  };
}

async function loadCatalog(auth: ProviderAuth): Promise<CatalogModel[]> {
  const { apiKey, baseUrl } = credentials(auth);
  const key = createHash("sha256")
    .update(JSON.stringify([baseUrl, apiKey]))
    .digest("hex");
  const cached = catalogs.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    catalogs.delete(key);
    catalogs.set(key, cached);
    return cached.models;
  }
  const pending = pendingCatalogs.get(key);
  if (pending) return pending;
  const task = (async () => {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    const models = mistralModelCatalog(await readJson<unknown>(response));
    catalogs.set(key, { expiresAt: Date.now() + CATALOG_TTL_MS, models });
    while (catalogs.size > MAX_CATALOG_ROUTES)
      catalogs.delete(catalogs.keys().next().value!);
    return models;
  })();
  pendingCatalogs.set(key, task);
  try {
    return await task;
  } finally {
    pendingCatalogs.delete(key);
  }
}

function requestOptions(request: CompletionRequest, auth: ProviderAuth) {
  request.signal?.throwIfAborted();
  return {
    provider: "Mistral",
    providerId: "mistral" as const,
    ...credentials(auth),
    model: request.model ?? defaultModels.mistral,
    messages: request.messages,
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    signal: request.signal,
    reasoning: request.thinking,
    reasoningStyle: "openai" as const,
    includeStreamUsage: false,
    tools: request.tools,
    toolChoice: request.toolChoice,
    parallelToolCalls: request.parallelToolCalls,
    reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
    forceReasoningReplay: request.forceReasoningReplay,
    purpose: request.purpose,
  };
}

function requestCatalog(
  auth: ProviderAuth,
  signal?: AbortSignal,
): Promise<CatalogModel[]> {
  const task = loadCatalog(auth).catch((error: unknown) => {
    if (
      error instanceof ProviderError &&
      (error.status === 401 || error.status === 403)
    )
      throw error;
    return [];
  });
  if (!signal) return task;
  return new Promise((resolve, reject) => {
    const abort = (): void =>
      reject(
        signal.reason ??
          new DOMException("The operation was aborted", "AbortError"),
      );
    signal.addEventListener("abort", abort, { once: true });
    void task
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

export const mistralProvider: LlmProvider = {
  id: "mistral",
  displayName: "Mistral",
  defaultModel: defaultModels.mistral,
  envVar: "MISTRAL_API_KEY",
  reasoningStyle: "openai",
  validateKey: (key) => /^[A-Za-z0-9_-]{16,}$/.test(key),
  async listModels(auth) {
    const models = await loadCatalog(auth);
    registerModelCatalog("mistral", models);
    return models.map((model) => model.id);
  },
  async ping(auth) {
    const { baseUrl, apiKey } = credentials(auth);
    await openAiCompatiblePing(baseUrl, apiKey);
  },
  async complete(request, auth) {
    const options = requestOptions(request, auth);
    const models = await requestCatalog(auth, request.signal);
    request.signal?.throwIfAborted();
    return withModelCatalogFacts("mistral", models, async () =>
      toCompletionResult(
        "mistral",
        options.model,
        await openAiCompatibleComplete(options),
      ),
    );
  },
  async stream(request, auth, onToken) {
    const options = requestOptions(request, auth);
    const models = await requestCatalog(auth, request.signal);
    request.signal?.throwIfAborted();
    return withModelCatalogFacts("mistral", models, async () =>
      toCompletionResult(
        "mistral",
        options.model,
        await openAiCompatibleStream({
          ...options,
          onToken,
          onStreamEvent: request.onStreamEvent,
          onToolCallDelta: request.onToolCallDelta,
        }),
      ),
    );
  },
};
