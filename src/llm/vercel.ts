import type { CompletionRequest, CompletionResult } from "../types.js";
import {
  defaultModels,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import { cachePolicyFields } from "./cache-policy-fields.js";
import { ingestOpenAiModelCatalog, readJson } from "./http.js";
import { runGenerationAttempt } from "./operation-usage.js";
import {
  responsesComplete,
  responsesReasoningSummary,
  responsesStream,
  type ResponsesDialectConfig,
} from "./responses-dialect.js";
import type { StreamTerminalPolicy } from "./stream-terminal.js";

const baseUrl = "https://ai-gateway.vercel.sh/v1";
const VERCEL_STREAM_TERMINAL: StreamTerminalPolicy = {
  proofs: ["response-completed", "response-incomplete"],
  naturalEofAccepted: false,
};
const CACHE_TTL_MS = 60 * 60 * 1000;
const NON_TEXT_MODEL =
  /embed|embedding|image-generation|imagen|dall-e|tts|whisper|video|moderation|rerank|transcrib/i;

export const vercelGatewayBaseUrl = baseUrl;
export const vercelGatewayFallbackModels = [
  "openai/gpt-5.4-mini",
  "openai/gpt-5.4",
  "anthropic/claude-sonnet-5",
  "google/gemini-3.5-flash",
];

interface ModelEntry {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly modalities?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isTextModel(entry: unknown): boolean {
  if (typeof entry === "string") return !NON_TEXT_MODEL.test(entry);
  const model = asRecord(entry) as ModelEntry | undefined;
  const id = typeof model?.id === "string" ? model.id.trim() : "";
  if (!id || NON_TEXT_MODEL.test(id)) return false;
  if (model?.type === "language") return true;
  const modalities = asRecord(model?.modalities);
  const output = stringList(modalities?.output).map((item) => item.toLowerCase());
  return output.length === 0 || output.includes("text");
}

function textModelEntries(payload: unknown): unknown[] {
  const entries = asRecord(payload)?.data;
  if (!Array.isArray(entries)) return [];
  return entries.filter(isTextModel);
}

function requireKey(auth: ProviderAuth): string {
  if (!auth.apiKey?.trim()) throw new Error("Vercel AI Gateway API key is required");
  return auth.apiKey;
}

export const VERCEL_RESPONSES_CONFIG: ResponsesDialectConfig = {
  baseUrl,
  providerId: "vercel",
  displayName: "Vercel AI Gateway",
  artifactDialect: "openai-compatible",
  terminalPolicy: VERCEL_STREAM_TERMINAL,
  buildHeaders(auth, accept) {
    return {
      "content-type": "application/json",
      accept,
      authorization: `Bearer ${auth.apiKey}`,
    };
  },
  reasoningPayload(reasoning) {
    if (!reasoning?.enabled) return undefined;
    return {
      effort: reasoning.effort,
      summary: responsesReasoningSummary(reasoning.effort),
    };
  },
  bodyExtras(context) {
    return {
      store: false,
      caching: "auto",
      cache_ttl: "5m",
      ...cachePolicyFields({
        provider: "vercel",
        model: context.model,
        messages: context.messages,
        purpose: context.purpose,
        policy: { kind: "affinity-key", affinityField: "prompt_cache_key" },
      }),
      include: ["reasoning.encrypted_content"],
    };
  },
};

let cachedModels: string[] | undefined;
let cachedAt = 0;
let catalogPending: Promise<string[]> | undefined;

export function resetVercelGatewayCatalogCache(): void {
  cachedModels = undefined;
  cachedAt = 0;
  catalogPending = undefined;
}

async function fetchModels(apiKey?: string): Promise<string[]> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  });
  const data = await readJson<{ data?: unknown[] }>(response);
  const models = ingestOpenAiModelCatalog("vercel", {
    ...data,
    data: textModelEntries(data),
  });
  return models;
}

async function loadModels(apiKey?: string): Promise<string[]> {
  const now = Date.now();
  if (cachedModels && now - cachedAt < CACHE_TTL_MS) return cachedModels;
  if (catalogPending) return catalogPending;
  let pending: Promise<string[]>;
  pending = fetchModels(apiKey)
    .then((models) => {
      if (models.length > 0) {
        cachedModels = models;
        cachedAt = Date.now();
        return models;
      }
      return cachedModels ?? vercelGatewayFallbackModels;
    })
    .catch(() => cachedModels ?? vercelGatewayFallbackModels)
    .finally(() => {
      if (catalogPending === pending) catalogPending = undefined;
    });
  catalogPending = pending;
  return pending;
}

export const vercelProvider: LlmProvider = {
  id: "vercel",
  reasoningStyle: "openai",
  displayName: "Vercel AI Gateway",
  defaultModel: defaultModels.vercel,
  envVar: "AI_GATEWAY_API_KEY",
  validateKey: (key: string) => key.trim().length >= 8,
  async listModels(auth: ProviderAuth): Promise<string[]> {
    return loadModels(auth.apiKey);
  },
  async ping(auth: ProviderAuth): Promise<void> {
    const apiKey = requireKey(auth);
    await loadModels(apiKey);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    const apiKey = requireKey(auth);
    const model = request.model ?? defaultModels.vercel;
    return runGenerationAttempt(
      request,
      {
        provider: "vercel",
        model,
        mode: "complete",
        reason: request.attemptReason ?? "initial",
      },
      () => responsesComplete(VERCEL_RESPONSES_CONFIG, request, { apiKey }, model),
    );
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    const apiKey = requireKey(auth);
    const model = request.model ?? defaultModels.vercel;
    return runGenerationAttempt(
      request,
      {
        provider: "vercel",
        model,
        mode: "stream",
        reason: request.attemptReason ?? "initial",
      },
      () => responsesStream(VERCEL_RESPONSES_CONFIG, request, { apiKey }, onToken, model),
    );
  },
};
