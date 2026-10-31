import { createHash } from "node:crypto";
import type { CompletionRequest } from "../types.js";
import { registerModelCatalog, type CatalogModel } from "./capabilities.js";
import { withModelCatalogFacts } from "./catalog-context.js";
import {
  openAiCompatibleComplete,
  openAiCompatiblePing,
  openAiCompatibleStream,
  ProviderError,
  readJson,
  toCompletionResult,
} from "./http.js";
import { normalizeEndpointUrl, type LlmProvider, type ProviderAuth } from "./provider.js";
import { isOfficialRiverEndpoint, loadRiverDocFacts } from "./river-docs.js";
import { RIVER_DEFAULT_MODEL, riverModelCatalog } from "./river-models.js";

const BASE_URL = "https://api.river.ai/v1";
const CATALOG_TTL_MS = 5 * 60 * 1000;
const MAX_CATALOG_ROUTES = 32;
const catalogs = new Map<string, { expiresAt: number; models: CatalogModel[] }>();
const pendingCatalogs = new Map<string, Promise<CatalogModel[]>>();

function credentials(auth: ProviderAuth): { apiKey: string; baseUrl: string } {
  if (!auth.apiKey) throw new Error("River API key is required");
  return {
    apiKey: auth.apiKey,
    baseUrl: normalizeEndpointUrl(auth.baseUrl ?? process.env.RIVER_BASE_URL ?? BASE_URL),
  };
}

async function loadCatalog(auth: ProviderAuth, refresh = false): Promise<CatalogModel[]> {
  const { baseUrl, apiKey } = credentials(auth);
  const key = createHash("sha256").update(JSON.stringify([baseUrl, apiKey])).digest("hex");
  const cached = catalogs.get(key);
  if (!refresh && cached && Date.now() < cached.expiresAt) {
    catalogs.delete(key);
    catalogs.set(key, cached);
    return cached.models;
  }
  const pending = pendingCatalogs.get(key);
  if (pending) return pending;
  const task = (async () => {
    const [response, docs] = await Promise.all([
      fetch(`${baseUrl}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      }),
      isOfficialRiverEndpoint(baseUrl) ? loadRiverDocFacts() : undefined,
    ]);
    const models = riverModelCatalog(await readJson<unknown>(response), docs);
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

function requestCatalog(auth: ProviderAuth, signal?: AbortSignal): Promise<CatalogModel[]> {
  const task = loadCatalog(auth).catch((error: unknown) => {
    if (error instanceof ProviderError && (error.status === 401 || error.status === 403))
      throw error;
    return [];
  });
  if (!signal) return task;
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(
      signal.reason ?? new DOMException("The operation was aborted", "AbortError"),
    );
    signal.addEventListener("abort", abort, { once: true });
    void task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

function requestOptions(request: CompletionRequest, auth: ProviderAuth) {
  request.signal?.throwIfAborted();
  return {
    provider: "River",
    providerId: "river" as const,
    ...credentials(auth),
    model: request.model ?? RIVER_DEFAULT_MODEL,
    messages: request.messages,
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    signal: request.signal,
    reasoning: request.thinking,
    reasoningStyle: "openai" as const,
    tools: request.tools,
    toolChoice: request.toolChoice,
    parallelToolCalls: request.parallelToolCalls,
    reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
    forceReasoningReplay: request.forceReasoningReplay,
    purpose: request.purpose,
  };
}

export const riverProvider: LlmProvider = {
  id: "river",
  displayName: "River",
  defaultModel: RIVER_DEFAULT_MODEL,
  envVar: "RIVER_API_KEY",
  reasoningStyle: "openai",
  validateKey: (key) => /^rv_[A-Za-z0-9_-]+$/.test(key),
  async listModels(auth) {
    const models = await loadCatalog(auth, true);
    registerModelCatalog("river", models);
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
    return withModelCatalogFacts("river", models, async () => toCompletionResult(
      "river", options.model, await openAiCompatibleComplete(options),
    ));
  },
  async stream(request, auth, onToken) {
    const options = requestOptions(request, auth);
    const models = await requestCatalog(auth, request.signal);
    request.signal?.throwIfAborted();
    return withModelCatalogFacts("river", models, async () => toCompletionResult(
      "river", options.model, await openAiCompatibleStream({
        ...options,
        onToken,
        onStreamEvent: request.onStreamEvent,
        onToolCallDelta: request.onToolCallDelta,
      }),
    ));
  },
};
