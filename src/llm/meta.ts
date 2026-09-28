import type {
  CompletionRequest,
  CompletionResult,
  ReasoningPreference,
} from "../types.js";
import { defaultModels, type LlmProvider, type ProviderAuth } from "./provider.js";
import { cachePolicyFields } from "./cache-policy-fields.js";
import { readJson, ingestOpenAiModelCatalog } from "./http.js";
import { registerModelReasoningEfforts } from "./capabilities.js";
import { runGenerationAttempt } from "./operation-usage.js";
import { META_STREAM_TERMINAL } from "./stream-terminal.js";
import {
  metaAcceptedEfforts,
  metaReasoningEffort,
  metaReasoningSummary,
} from "./meta-effort.js";
import {
  responsesComplete,
  responsesStream,
  type ResponsesDialectConfig,
} from "./responses-dialect.js";

export { parseResponsesUsage as parseMetaUsage } from "./responses-dialect.js";

const baseUrl = "https://api.meta.ai/v1";

const modelCache = new Map<string, { models: string[]; fetchedAt: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000;

function metaReasoningPayload(
  reasoning: ReasoningPreference | undefined,
  model: string,
): Record<string, unknown> {
  const enabled = Boolean(reasoning?.enabled);
  if (!enabled) return { effort: "minimal" };
  const eff = metaReasoningEffort(reasoning?.effort ?? "medium", model);
  return { effort: eff, summary: metaReasoningSummary(eff) };
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
    const now = Date.now();
    const cached = modelCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.models;
    }
    try {
      const headers: Record<string, string> = {};
      if (auth.apiKey) headers["authorization"] = `Bearer ${auth.apiKey}`;
      const response = await fetch(`${baseUrl}/models`, { headers });
      const data = await readJson<{ data?: Array<{ id?: string }> }>(response);
      const models = ingestOpenAiModelCatalog("meta", data);
      for (const model of models) {
        registerModelReasoningEfforts("meta", model, [
          ...metaAcceptedEfforts(model),
        ]);
      }
      if (models.length > 0) {
        modelCache.set(cacheKey, { models, fetchedAt: now });
      }
      return models;
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
      () => responsesComplete(META_RESPONSES_CONFIG, request, auth, model),
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
      () => responsesStream(META_RESPONSES_CONFIG, request, auth, onToken, model),
    );
  },
};
