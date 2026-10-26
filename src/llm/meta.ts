import type {
  CompletionRequest,
  CompletionResult,
  ReasoningPreference,
} from "../types.js";
import { defaultModels, type LlmProvider, type ProviderAuth } from "./provider.js";
import { cachePolicyFields } from "./cache-policy-fields.js";
import { readJson } from "./http.js";
import { displayReasoningEfforts, registerModelCatalog, type CatalogModel } from "./capabilities.js";
import { catalogEntriesFromPayload } from "./catalog-facts.js";
import { withModelCatalogFacts } from "./catalog-context.js";
import { parseModelCatalogEntries } from "./wire/model-catalog.js";
import { mainEffortProbe } from "./main-effort-discovery.js";
import { runGenerationAttempt } from "./operation-usage.js";
import { META_STREAM_TERMINAL } from "./stream-terminal.js";
import {
  metaReasoningEffort,
  metaReasoningSummary,
} from "./meta-effort.js";
import {
  responsesComplete,
  responsesStream,
  type ResponsesDialectConfig,
} from "./responses-dialect.js";
import { modelListCache } from "./model-list-cache.js";

export { parseResponsesUsage as parseMetaUsage } from "./responses-dialect.js";

const baseUrl = "https://api.meta.ai/v1";

const modelCache = modelListCache<CatalogModel[]>("meta");

function metaReasoningPayload(
  reasoning: ReasoningPreference | undefined,
  model: string,
): Record<string, unknown> | undefined {
  const probe = mainEffortProbe("meta", model);
  const efforts = probe ? [probe] : displayReasoningEfforts("meta", model);
  const requested = reasoning?.enabled ? reasoning.effort : "none";
  const effort = metaReasoningEffort(requested, model, efforts);
  if (effort === undefined) return undefined;
  return reasoning?.enabled
    ? { effort, summary: metaReasoningSummary(effort) }
    : { effort };
}

const META_RESPONSES_CONFIG: ResponsesDialectConfig = {
  baseUrl,
  providerId: "meta",
  displayName: "Meta Model API",
  artifactDialect: "meta-responses",
  terminalPolicy: META_STREAM_TERMINAL,
  buildHeaders(auth, accept) {
    return {
      "content-type": "application/json",
      accept,
      authorization: `Bearer ${auth.apiKey}`,
    };
  },
  reasoningPayload(reasoning, model) {
    return metaReasoningPayload(reasoning, model ?? defaultModels.meta);
  },
  bodyExtras(context) {
    return {
      store: false,
      ...cachePolicyFields({
        provider: "meta",
        model: context.model,
        messages: context.messages,
        purpose: context.purpose,
        policy: { kind: "affinity-key", affinityField: "prompt_cache_key" },
      }),
      prompt_cache_retention: "24h",
      include: ["reasoning.encrypted_content"],
    };
  },
};

export const metaProvider: LlmProvider = {
  id: "meta",
  reasoningStyle: "meta",
  displayName: "Meta Model API",
  defaultModel: defaultModels.meta,
  envVar: "MODEL_API_KEY",
  validateKey: (key: string) => /^[A-Za-z0-9_.-]{8,}$/.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    const cacheKey = auth.apiKey ?? "";
    const cached = modelCache.fresh(cacheKey);
    if (cached) {
      registerModelCatalog("meta", cached);
      return cached.map((model) => model.id).sort();
    }
    try {
      const headers: Record<string, string> = {};
      if (auth.apiKey) headers["authorization"] = `Bearer ${auth.apiKey}`;
      const response = await fetch(`${baseUrl}/models`, { headers });
      const data = await readJson<unknown>(response);
      const models = parseModelCatalogEntries(catalogEntriesFromPayload(data));
      registerModelCatalog("meta", models);
      modelCache.store(models, cacheKey);
      return models.map((model) => model.id).sort();
    } catch {
      return [];
    }
  },
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("Meta Model API key is required");
    const response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${auth.apiKey}` },
    });
    await readJson<unknown>(response);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Meta Model API key is required");
    const model = request.model ?? defaultModels.meta;
    return runGenerationAttempt(
      request,
      {
        provider: "meta",
        model,
        mode: "complete",
        reason: request.attemptReason ?? "initial",
      },
      () => withModelCatalogFacts("meta", modelCache.fresh(auth.apiKey) ?? [],
        () => responsesComplete(META_RESPONSES_CONFIG, request, auth, model)),
    );
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Meta Model API key is required");
    const model = request.model ?? defaultModels.meta;
    return runGenerationAttempt(
      request,
      {
        provider: "meta",
        model,
        mode: "stream",
        reason: request.attemptReason ?? "initial",
      },
      () => withModelCatalogFacts("meta", modelCache.fresh(auth.apiKey) ?? [],
        () => responsesStream(META_RESPONSES_CONFIG, request, auth, onToken, model)),
    );
  },
};
