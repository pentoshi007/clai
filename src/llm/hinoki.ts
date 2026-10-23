import { createHash } from "node:crypto";
import type { CompletionRequest } from "../types.js";
import { registerModelCatalog, type CatalogModel } from "./capabilities.js";
import { withModelCatalogFacts } from "./catalog-context.js";
import { HINOKI_DEFAULT_MODEL, hinokiModelCatalog } from "./hinoki-models.js";
import { openAiCompatibleComplete, openAiCompatibleStream, ProviderError, readJson, toCompletionResult } from "./http.js";
import { onModelListInvalidated } from "./model-list-cache.js";
import { normalizeEndpointUrl, type LlmProvider, type ProviderAuth } from "./provider.js";

const BASE_URL = "https://inference.hinoki.security/v1";
const CATALOG_TTL_MS = 5 * 60_000;
const RETRY_COOLDOWN_MS = 60_000;
interface CatalogEntry {
  models: CatalogModel[];
  expiresAt: number;
}
const catalogs = new Map<string, CatalogEntry>();
const pendingCatalogs = new Map<string, Promise<CatalogModel[]>>();
let catalogGeneration = 0;

export function resetHinokiModelCatalogCache(): void {
  catalogGeneration += 1;
  catalogs.clear();
  pendingCatalogs.clear();
}

onModelListInvalidated("hinoki", resetHinokiModelCatalogCache);

function credentials(auth: ProviderAuth): { apiKey: string; baseUrl: string } {
  if (!auth.apiKey?.trim()) throw new Error("Hinoki API key is required");
  return {
    apiKey: auth.apiKey,
    baseUrl: normalizeEndpointUrl(auth.baseUrl ?? process.env.HINOKI_BASE_URL ?? BASE_URL),
  };
}

function rememberCatalog(key: string, entry: CatalogEntry): void {
  catalogs.delete(key);
  catalogs.set(key, entry);
  while (catalogs.size > 32) catalogs.delete(catalogs.keys().next().value!);
}

async function loadCatalog(auth: ProviderAuth, refresh = false): Promise<CatalogModel[]> {
  const { baseUrl, apiKey } = credentials(auth);
  const key = createHash("sha256").update(JSON.stringify([baseUrl, apiKey])).digest("hex");
  const cached = catalogs.get(key);
  if (!refresh && cached && Date.now() < cached.expiresAt) return cached.models;
  const pending = pendingCatalogs.get(key);
  if (pending) return pending;
  const generation = catalogGeneration;
  const task = (async () => {
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      const models = hinokiModelCatalog(await readJson<unknown>(response));
      if (!models.length) throw new Error("Hinoki returned no chat models");
      if (catalogGeneration === generation) rememberCatalog(key, { models, expiresAt: Date.now() + CATALOG_TTL_MS });
      return models;
    } catch (error) {
      if (error instanceof ProviderError && (error.status === 401 || error.status === 403)) throw error;
      if (catalogGeneration === generation) rememberCatalog(key, {
        models: cached?.models ?? [], expiresAt: Date.now() + RETRY_COOLDOWN_MS,
      });
      if (cached?.models.length) return cached.models;
      throw error;
    }
  })();
  pendingCatalogs.set(key, task);
  try {
    return await task;
  } finally {
    if (pendingCatalogs.get(key) === task) pendingCatalogs.delete(key);
  }
}

async function requestCatalog(auth: ProviderAuth, signal?: AbortSignal): Promise<CatalogModel[]> {
  const task = loadCatalog(auth).catch((error: unknown) => {
    if (error instanceof ProviderError && (error.status === 401 || error.status === 403)) throw error;
    return [];
  });
  if (!signal) return task;
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    void task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

function requestOptions(request: CompletionRequest, auth: ProviderAuth) {
  request.signal?.throwIfAborted();
  return {
    provider: "Hinoki",
    providerId: "hinoki" as const,
    ...credentials(auth),
    model: request.model ?? HINOKI_DEFAULT_MODEL,
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

export const hinokiProvider: LlmProvider = {
  id: "hinoki",
  displayName: "Hinoki",
  defaultModel: HINOKI_DEFAULT_MODEL,
  envVar: "HINOKI_API_KEY",
  reasoningStyle: "openai",
  validateKey: (key) => /^\S{16,}$/.test(key),
  async listModels(auth) {
    const models = await loadCatalog(auth, true);
    registerModelCatalog("hinoki", models);
    return models.map((model) => model.id);
  },
  async ping(auth) {
    await loadCatalog(auth, true);
  },
  async complete(request, auth) {
    const options = requestOptions(request, auth);
    const models = await requestCatalog(auth, request.signal);
    request.signal?.throwIfAborted();
    if (models.length) registerModelCatalog("hinoki", models);
    return withModelCatalogFacts("hinoki", models, async () => toCompletionResult(
      "hinoki", options.model, await openAiCompatibleComplete(options),
    ));
  },
  async stream(request, auth, onToken) {
    const options = requestOptions(request, auth);
    const models = await requestCatalog(auth, request.signal);
    request.signal?.throwIfAborted();
    if (models.length) registerModelCatalog("hinoki", models);
    return withModelCatalogFacts("hinoki", models, async () => toCompletionResult(
      "hinoki", options.model, await openAiCompatibleStream({
        ...options, onToken, onStreamEvent: request.onStreamEvent, onToolCallDelta: request.onToolCallDelta,
      }),
    ));
  },
};
