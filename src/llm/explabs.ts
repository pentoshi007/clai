import type { CompletionRequest, CompletionResult } from "../types.js";
import {
  defaultModels,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import { bareModelId } from "./model-families.js";
import { singleLeadingSystemMessages } from "./system-messages.js";
import {
  ingestOpenAiModelCatalog,
  openAiCompatibleComplete,
  openAiCompatiblePing,
  openAiCompatibleStream,
  ProviderError,
  readJson,
  toCompletionResult,
} from "./http.js";
import { sleep } from "./routing/error-classification.js";
import { streamAlreadyEmitted } from "./stream-progress.js";

const API_ROOT = "https://api.experientiallabs.ai";

export const explabsBaseUrl = `${API_ROOT}/v1`;
export const explabsCatalogUrl = `${API_ROOT}/api/models`;

const RESPONSES_NATIVE_MODEL = /(?:^|[-./])(?:gpt-5|gpt-6|o[1-4])(?![a-z])/;

function responsesFirstForModel(model: string): boolean {
  return RESPONSES_NATIVE_MODEL.test(bareModelId(model));
}

export const explabsFallbackModels = [
  "claude-fable-5.1",
  "claude-fable-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "gemini-3.7-flash",
  "kimi-k3",
  "glm-5.3",
  "glm-5.3-flash",
  "deepseek-v4-flash",
  "qwen3.8-27b",
];

const NON_CHAT_MODEL =
  /embed|image|imagen|dall-e|tts|whisper|video|moderation|rerank|transcribe|-batch$/i;

const CATALOG_PAGE_LIMIT = 500;
const CATALOG_MAX_PAGES = 10;

const EFFORT_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

interface ExplabsCatalogRow {
  readonly model?: unknown;
  readonly providers?: unknown;
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

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function providerCapabilities(row: ExplabsCatalogRow): Record<string, unknown>[] {
  const providers = Array.isArray(row.providers) ? row.providers : [];
  return providers
    .map((provider) => asRecord(asRecord(provider)?.capabilities))
    .filter((caps): caps is Record<string, unknown> => caps !== undefined);
}

function orderedEfforts(caps: readonly Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const capsEntry of caps) {
    for (const effort of stringList(capsEntry.supported_reasoning_efforts)) {
      seen.add(effort.trim().toLowerCase());
    }
  }
  const ordered = EFFORT_ORDER.filter((effort) => seen.has(effort));
  const extra = [...seen].filter(
    (effort) => !(EFFORT_ORDER as readonly string[]).includes(effort),
  );
  return [...ordered, ...extra];
}

function reasoningFacts(
  model: Record<string, unknown>,
  caps: readonly Record<string, unknown>[],
): Record<string, unknown> | false {
  const reasoningCaps = caps.filter(
    (capsEntry) => capsEntry.supports_reasoning === true,
  );
  const declared =
    reasoningCaps.length > 0 || asRecord(model.supported_params)?.reasoning === true;
  if (!declared) return false;

  const efforts = orderedEfforts(reasoningCaps);
  const defaultEffort = reasoningCaps
    .map((capsEntry) => capsEntry.reasoning_default_effort)
    .find(
      (effort): effort is string =>
        typeof effort === "string" && effort.trim().length > 0,
    );
  return {
    supported_efforts: efforts.length > 0 ? efforts : null,
    mandatory:
      reasoningCaps.length > 0 &&
      reasoningCaps.every(
        (capsEntry) => capsEntry.reasoning_effort_required === true,
      ),
    ...(defaultEffort !== undefined
      ? {
          default_effort: defaultEffort,
          default_enabled: defaultEffort !== "none",
        }
      : {}),
  };
}

function samplingFacts(
  model: Record<string, unknown>,
  caps: readonly Record<string, unknown>[],
): Record<string, null> | undefined {
  const params = asRecord(model.supported_params);
  const pinnedTemperature = caps.some(
    (capsEntry) =>
      typeof capsEntry.minimum_temperature === "number" &&
      typeof capsEntry.maximum_temperature === "number" &&
      capsEntry.minimum_temperature === capsEntry.maximum_temperature,
  );
  const omit: Record<string, null> = {};
  if (
    params?.temperature === false ||
    pinnedTemperature ||
    caps.some((capsEntry) => capsEntry.supports_temperature === false)
  ) {
    omit.temperature = null;
  }
  if (
    params?.top_p === false ||
    caps.some((capsEntry) => capsEntry.supports_top_p === false)
  ) {
    omit.top_p = null;
  }
  return Object.keys(omit).length > 0 ? omit : undefined;
}

function catalogFactsEntry(
  row: ExplabsCatalogRow,
): { id: string; entry: Record<string, unknown> } | undefined {
  const model = asRecord(row.model);
  if (!model) return undefined;
  const slug = typeof model.slug === "string" ? model.slug.trim() : "";
  if (!slug || NON_CHAT_MODEL.test(slug)) return undefined;
  const outputModalities = stringList(model.output_modalities);
  if (
    outputModalities.length > 0 &&
    !outputModalities.some((modality) => modality.toLowerCase() === "text")
  ) {
    return undefined;
  }

  const caps = providerCapabilities(row);
  const reasoning = reasoningFacts(model, caps);
  const sampling = samplingFacts(model, caps);
  const contextWindow = positiveInteger(model.context_window);
  const maxOutput = positiveInteger(model.max_output_tokens);
  const inputModalities = stringList(model.input_modalities);
  const entry: Record<string, unknown> = {
    id: slug,
    reasoning,
    ...(reasoning !== false
      ? { supported_parameters: ["reasoning_effort", "reasoning"] }
      : {}),
    ...(contextWindow !== undefined ? { context_window: contextWindow } : {}),
    ...(maxOutput !== undefined ? { max_completion_tokens: maxOutput } : {}),
    ...(inputModalities.length > 0
      ? { input_modalities: inputModalities }
      : {}),
    ...(sampling !== undefined ? { default_parameters: sampling } : {}),
  };
  return { id: slug, entry };
}

export interface ExplabsCatalogIndex {
  readonly entries: Map<string, Record<string, unknown>>;
  readonly excluded: Set<string>;
}

export function explabsCatalogIndex(rows: readonly unknown[]): ExplabsCatalogIndex {
  const entries = new Map<string, Record<string, unknown>>();
  const excluded = new Set<string>();
  for (const raw of rows) {
    const row = asRecord(raw) ?? {};
    const slug = typeof asRecord(row.model)?.slug === "string"
      ? (asRecord(row.model)!.slug as string).trim()
      : "";
    const parsed = catalogFactsEntry(row);
    if (parsed) entries.set(parsed.id, parsed.entry);
    else if (slug) excluded.add(slug);
  }
  return { entries, excluded };
}

let cachedModels: string[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

export function resetExplabsCatalogCache(): void {
  cachedModels = null;
  lastFetchTime = 0;
}

export function explabsAuthHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}

function requireKey(auth: ProviderAuth): string {
  if (!auth.apiKey) throw new Error("Experiential Labs API key is required");
  return auth.apiKey;
}

async function getJson<T>(
  url: string,
  apiKey: string | undefined,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    headers: apiKey ? explabsAuthHeaders(apiKey) : {},
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return readJson<T>(response);
}

async function fetchCatalogFacts(
  apiKey: string | undefined,
  signal?: AbortSignal,
): Promise<ExplabsCatalogIndex> {
  const rows: unknown[] = [];
  for (let page = 0; page < CATALOG_MAX_PAGES; page += 1) {
    const query = `?limit=${CATALOG_PAGE_LIMIT}&offset=${rows.length}`;
    const data = await getJson<{
      models?: unknown[];
      total?: unknown;
    }>(`${explabsCatalogUrl}${query}`, apiKey, signal);
    const batch = Array.isArray(data.models) ? data.models : [];
    rows.push(...batch);
    const total = positiveInteger(data.total);
    if (batch.length === 0 || (total !== undefined && rows.length >= total)) {
      break;
    }
    if (batch.length < CATALOG_PAGE_LIMIT && total === undefined) break;
  }
  return explabsCatalogIndex(rows);
}

async function fetchCallableIds(
  apiKey: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const data = await getJson<{ data?: unknown }>(
    `${explabsBaseUrl}/models`,
    apiKey,
    signal,
  );
  const entries = Array.isArray(data.data) ? data.data : [];
  return entries
    .map((entry) => {
      if (typeof entry === "string") return entry.trim();
      const id = asRecord(entry)?.id;
      return typeof id === "string" ? id.trim() : "";
    })
    .filter((id) => id.length > 0 && !NON_CHAT_MODEL.test(id));
}

async function fetchModels(
  apiKey: string | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!apiKey) {
    const catalog = await fetchCatalogFacts(undefined, signal);
    return ingestOpenAiModelCatalog("explabs", [...catalog.entries.values()]);
  }
  const callable = await fetchCallableIds(apiKey, signal);
  let catalog: ExplabsCatalogIndex;
  try {
    catalog = await fetchCatalogFacts(apiKey, signal);
  } catch {
    catalog = { entries: new Map(), excluded: new Set() };
  }
  const entries: unknown[] = [];
  const seen = new Set<string>();
  for (const id of callable) {
    if (seen.has(id) || catalog.excluded.has(id)) continue;
    seen.add(id);
    entries.push(catalog.entries.get(id) ?? { id });
  }
  return ingestOpenAiModelCatalog("explabs", entries);
}

const THROTTLE_MAX_RETRIES = 2;
const THROTTLE_MAX_WAIT_MS = 20_000;
const THROTTLE_DEFAULT_WAIT_MS: readonly number[] = [5_000, 10_000];
const THROTTLE_SIGNATURE = /unavailable_route|provider throttled/i;

function isGatewayThrottle(error: unknown): error is ProviderError {
  if (!(error instanceof ProviderError) || error.status !== 429) return false;
  if (streamAlreadyEmitted(error)) return false;
  return (
    error.retryAfterSeconds !== undefined ||
    THROTTLE_SIGNATURE.test(`${error.message}\n${error.body ?? ""}`)
  );
}

function throttleRetryWaitMs(error: ProviderError, attempt: number): number {
  const seconds = error.retryAfterSeconds;
  const advertised =
    seconds !== undefined && Number.isFinite(seconds) && seconds >= 0
      ? Math.ceil(seconds * 1000)
      : undefined;
  if (advertised === undefined) {
    return THROTTLE_DEFAULT_WAIT_MS[
      Math.min(attempt, THROTTLE_DEFAULT_WAIT_MS.length - 1)
    ]!;
  }
  return Math.min(advertised, THROTTLE_MAX_WAIT_MS);
}

async function dispatchWithThrottleRetry<T>(
  dispatch: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await dispatch();
    } catch (error) {
      if (attempt >= THROTTLE_MAX_RETRIES || !isGatewayThrottle(error)) {
        throw error;
      }
      await sleep(throttleRetryWaitMs(error, attempt), signal);
    }
  }
}

export const explabsProvider: LlmProvider = {
  id: "explabs",
  reasoningStyle: "openai",
  displayName: "Experiential Labs",
  defaultModel: defaultModels.explabs,
  envVar: "EXPLABS_API_KEY",
  validateKey: (key: string) => /^xpl_[0-9a-f]{40,}$/i.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    const now = Date.now();
    if (cachedModels && now - lastFetchTime < CACHE_TTL_MS) return cachedModels;
    try {
      const models = await fetchModels(auth.apiKey);
      if (models.length > 0) {
        cachedModels = models;
        lastFetchTime = now;
        return models;
      }
      return cachedModels ?? explabsFallbackModels;
    } catch {
      return cachedModels ?? explabsFallbackModels;
    }
  },
  async ping(auth: ProviderAuth): Promise<void> {
    await openAiCompatiblePing(explabsBaseUrl, requireKey(auth));
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    const apiKey = requireKey(auth);
    const model = request.model ?? defaultModels.explabs;
    const payload = await dispatchWithThrottleRetry(
      () =>
        openAiCompatibleComplete({
          responsesFirst: responsesFirstForModel(model),
          provider: "Experiential Labs",
          providerId: "explabs",
          baseUrl: explabsBaseUrl,
          apiKey,
          model,
          messages: singleLeadingSystemMessages(request.messages),
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
        }),
      request.signal,
    );
    return toCompletionResult("explabs", model, payload);
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    const apiKey = requireKey(auth);
    const model = request.model ?? defaultModels.explabs;
    const payload = await dispatchWithThrottleRetry(
      () =>
        openAiCompatibleStream({
          responsesFirst: responsesFirstForModel(model),
          provider: "Experiential Labs",
          providerId: "explabs",
          baseUrl: explabsBaseUrl,
          apiKey,
          model,
          messages: singleLeadingSystemMessages(request.messages),
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
        }),
      request.signal,
    );
    return toCompletionResult("explabs", model, payload);
  },
};
