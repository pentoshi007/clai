import { createHash } from "node:crypto";
import type { CompletionRequest } from "../types.js";
import { registerModelCatalog, type CatalogModel } from "./capabilities.js";
import { withModelCatalogFacts } from "./catalog-context.js";
import { constellationModelCatalog } from "./constellation-models.js";
import {
  openAiCompatibleComplete,
  openAiCompatibleStream,
  ProviderError,
  readJson,
  toCompletionResult,
} from "./http.js";
import { defaultModels, type LlmProvider, type ProviderAuth } from "./provider.js";

const DEFAULT_BASE_URL = "https://gateway.constellationgate.ai/v1";
const CATALOG_TTL_MS = 60_000;
const catalogs = new Map<string, { expiresAt: number; models: CatalogModel[] }>();
const pendingCatalogs = new Map<string, Promise<CatalogModel[]>>();

function catalogKey(auth: ProviderAuth): string {
  return createHash("sha256").update(`${auth.baseUrl ?? ""}\u0000${auth.apiKey ?? ""}`).digest("hex");
}

function baseUrl(auth: ProviderAuth): string {
  const configured = auth.baseUrl?.trim();
  return configured ? configured.replace(/\/+$/, "") : DEFAULT_BASE_URL;
}

function apiKey(auth: ProviderAuth): string {
  if (!auth.apiKey) throw new Error("Constellation Gate API key is required");
  return auth.apiKey;
}

async function loadCatalog(auth: ProviderAuth): Promise<CatalogModel[]> {
  const key = catalogKey(auth);
  const cached = catalogs.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.models;
  const pending = pendingCatalogs.get(key);
  if (pending) return pending;
  const task = (async () => {
    try {
      const response = await fetch(`${baseUrl(auth)}/models`, {
        headers: auth.apiKey ? { authorization: `Bearer ${auth.apiKey}` } : {},
        signal: AbortSignal.timeout(15_000),
      });
      const models = constellationModelCatalog(await readJson<unknown>(response));
      if (!models.length) throw new Error("Constellation Gate returned no chat models");
      catalogs.delete(key);
      catalogs.set(key, { expiresAt: Date.now() + CATALOG_TTL_MS, models });
      while (catalogs.size > 32) catalogs.delete(catalogs.keys().next().value!);
      return models;
    } catch (error) {
      if (error instanceof ProviderError && (error.status === 401 || error.status === 403)) throw error;
      if (cached) return cached.models;
      throw error;
    }
  })();
  pendingCatalogs.set(key, task);
  try {
    return await task;
  } finally {
    pendingCatalogs.delete(key);
  }
}

async function requestCatalog(auth: ProviderAuth, signal?: AbortSignal): Promise<CatalogModel[]> {
  const task = loadCatalog(auth).catch((error: unknown) => {
    if (error instanceof ProviderError && (error.status === 401 || error.status === 403)) throw error;
    return [];
  });
  const models = await (signal ? new Promise<CatalogModel[]>((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    void task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  }) : task);
  signal?.throwIfAborted();
  if (models.length) registerModelCatalog("constellation", models);
  return models;
}

function requestOptions(request: CompletionRequest, auth: ProviderAuth) {
  request.signal?.throwIfAborted();
  return {
    provider: "Constellation Gate",
    providerId: "constellation" as const,
    baseUrl: baseUrl(auth),
    apiKey: apiKey(auth),
    model: request.model ?? defaultModels.constellation,
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

export const constellationProvider: LlmProvider = {
  id: "constellation",
  displayName: "Constellation Gate",
  defaultModel: defaultModels.constellation,
  envVar: "GATE_API_KEY",
  reasoningStyle: "openai",
  validateKey: (key) => /^sk-gw-[A-Za-z0-9_-]{8,}$/.test(key),
  async listModels(auth) {
    const models = await loadCatalog(auth);
    registerModelCatalog("constellation", models);
    return models.map((model) => model.id);
  },
  async ping(auth) {
    const response = await fetch(`${baseUrl(auth)}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey(auth)}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: defaultModels.constellation,
        messages: [{ role: "user", content: "Reply with ok." }],
        max_completion_tokens: 1,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    await readJson<unknown>(response);
  },
  async complete(request, auth) {
    const options = requestOptions(request, auth);
    const models = await requestCatalog(auth, request.signal);
    return withModelCatalogFacts("constellation", models, async () => toCompletionResult(
      "constellation", options.model, await openAiCompatibleComplete(options),
    ));
  },
  async stream(request, auth, onToken) {
    const options = requestOptions(request, auth);
    const models = await requestCatalog(auth, request.signal);
    return withModelCatalogFacts("constellation", models, async () => toCompletionResult(
      "constellation", options.model, await openAiCompatibleStream({
        ...options,
        onToken,
        onToolCallDelta: request.onToolCallDelta,
        onStreamEvent: request.onStreamEvent,
      }),
    ));
  },
};

export function resetConstellationModelCatalogCache(): void {
  catalogs.clear();
  pendingCatalogs.clear();
}
