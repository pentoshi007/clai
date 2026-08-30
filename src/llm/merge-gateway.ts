import type { CompletionRequest, CompletionResult } from "../types.js";
import {
  defaultModels,
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

const GATEWAY_ROOT = "https://api-gateway.merge.dev/v1";

export const mergeGatewayBaseUrl = `${GATEWAY_ROOT}/openai`;

export const mergeGatewayFallbackModels = [
  "openai/gpt-5.2",
  "openai/gpt-5.2-mini",
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "openai/o4-mini",
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-opus-4-6",
  "anthropic/claude-3-5-haiku-20241022",
  "google/gemini-3.5-flash",
  "google/gemini-2.0-flash",
  "google/gemini-2.5-pro",
  "deepseek/deepseek-chat",
  "deepseek/deepseek-reasoner",
  "meta/llama-3.3-70b-instruct",
  "mistral/mistral-large-latest",
];

const NON_CHAT_MODEL =
  /embed|image|imagen|dall-e|tts|whisper|video|moderation|rerank|transcribe/i;

// The native catalog is cursor paginated and caps `limit` at 500; one page
// covers the whole catalog today (276 entries) and the cursor loop below keeps
// that from silently truncating as it grows.
const NATIVE_CATALOG_PAGE_LIMIT = 500;
const NATIVE_CATALOG_MAX_PAGES = 10;

// Effort names ordered cheapest → most expensive, so a model's advertised set is
// presented in a stable order rather than the vendor's arbitrary one.
const EFFORT_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

interface MergeModelEntry {
  id?: unknown;
  object?: unknown;
  supported_endpoint_types?: unknown;
  capabilities?: unknown;
}

/**
 * One upstream host for a model. Merge fans a single model id out across several
 * vendors (glm-5.3-flash runs on zai, particle and baseten) and picks one per
 * request, so capabilities have to be reconciled across all of them.
 */
interface MergeVendorEntry {
  readonly availability_status?: unknown;
  readonly context_window?: unknown;
  readonly max_output_tokens?: unknown;
  readonly capabilities?: {
    readonly input?: unknown;
    readonly supports_reasoning?: unknown;
    readonly reasoning?: {
      readonly configurable?: unknown;
      readonly disable_supported?: unknown;
      readonly default_enabled?: unknown;
      readonly effort_values?: unknown;
    } | null;
  };
}

interface MergeNativeEntry {
  readonly model?: unknown;
  readonly vendors?: Record<string, MergeVendorEntry> | undefined;
  readonly aliases?: unknown;
}

function entriesFrom(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const container = payload as { data?: unknown; models?: unknown } | undefined;
  if (Array.isArray(container?.data)) return container.data;
  if (Array.isArray(container?.models)) return container.models;
  return [];
}

function supportsChat(entry: MergeModelEntry): boolean {
  const endpoints = entry.supported_endpoint_types;
  if (Array.isArray(endpoints) && endpoints.length > 0) {
    return endpoints.some(
      (value) =>
        typeof value === "string" &&
        (value === "openai" || value.includes("chat") || value.includes("responses")),
    );
  }
  return true;
}

function chatModelsFromCatalog(payload: unknown): unknown[] {
  return entriesFrom(payload).filter((entry) => {
    if (typeof entry === "string") return !NON_CHAT_MODEL.test(entry);
    const item = entry as MergeModelEntry;
    const id = typeof item.id === "string" ? item.id : "";
    if (!id || NON_CHAT_MODEL.test(id)) return false;
    return supportsChat(item);
  });
}

function stringSet(value: unknown): Set<string> {
  const items = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
  return new Set(items.map((item) => item.trim().toLowerCase()).filter(Boolean));
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * The hosts Merge may actually route to. Unavailable vendors are dropped; if that
 * leaves nothing, every declared vendor is used so a temporarily degraded model
 * keeps its capabilities instead of silently losing reasoning support.
 */
function routableVendors(entry: MergeNativeEntry): MergeVendorEntry[] {
  const vendors = Object.values(entry.vendors ?? {});
  const available = vendors.filter(
    (vendor) => vendor.availability_status === "available",
  );
  return available.length > 0 ? available : vendors;
}

/**
 * Reconciles reasoning capability across every vendor that can serve the model.
 *
 * Efforts are unioned: Merge answers an effort the resolved route cannot honour
 * with a `reasoning_effort_adjusted` warning and the next best level rather than
 * an error (verified live), so offering a superset costs nothing while offering a
 * subset would hide real capability. Disabling, by contrast, is only claimed when
 * every route allows it.
 */
function reasoningFacts(
  vendors: readonly MergeVendorEntry[],
): Record<string, unknown> | false {
  const reasoning = vendors
    .map((vendor) => vendor.capabilities)
    .filter((capabilities) => capabilities?.supports_reasoning === true)
    .map((capabilities) => capabilities?.reasoning)
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  if (reasoning.length === 0) return false;

  const efforts = new Set<string>();
  for (const entry of reasoning) {
    for (const effort of stringSet(entry.effort_values)) efforts.add(effort);
  }
  const ordered = EFFORT_ORDER.filter((effort) => efforts.has(effort));
  return {
    default_enabled: reasoning.some((entry) => entry.default_enabled === true),
    mandatory: reasoning.every((entry) => entry.disable_supported !== true),
    // An empty list means on/off only (no effort ladder); omitting the key lets
    // the endpoint profile supply its own vocabulary instead of publishing none.
    ...(ordered.length > 0 ? { supported_efforts: ordered } : {}),
  };
}

/** Modalities every routable vendor accepts, so a route swap cannot reject an image. */
function sharedInputModalities(vendors: readonly MergeVendorEntry[]): string[] {
  const perVendor = vendors.map((vendor) => stringSet(vendor.capabilities?.input));
  if (perVendor.length === 0) return [];
  const [first, ...rest] = perVendor;
  return [...first!].filter((modality) =>
    rest.every((other) => other.has(modality)),
  );
}

/** Smallest limit any routable vendor imposes — the only value safe for every route. */
function sharedLimit(
  vendors: readonly MergeVendorEntry[],
  read: (vendor: MergeVendorEntry) => unknown,
): number | undefined {
  const values = vendors
    .map((vendor) => positive(read(vendor)))
    .filter((value): value is number => value !== undefined);
  return values.length > 0 ? Math.min(...values) : undefined;
}

/**
 * Rewrites one native entry into the generic catalog shape `parseCatalogFacts`
 * understands, so Merge's published metadata drives reasoning support, the effort
 * list, vision and token limits instead of clai's name-pattern guesses.
 */
function nativeFacts(entry: MergeNativeEntry): Record<string, unknown> {
  const vendors = routableVendors(entry);
  const context = sharedLimit(vendors, (vendor) => vendor.context_window);
  const output = sharedLimit(vendors, (vendor) => vendor.max_output_tokens);
  return {
    reasoning: reasoningFacts(vendors),
    input_modalities: sharedInputModalities(vendors),
    ...(context !== undefined ? { context_window: context } : {}),
    ...(output !== undefined ? { max_completion_tokens: output } : {}),
  };
}

function aliasIds(entry: MergeNativeEntry): string[] {
  if (!Array.isArray(entry.aliases)) return [];
  return entry.aliases
    .map((alias) => (alias as { model?: unknown } | null)?.model)
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
}

/**
 * Indexes native metadata by every id it can be requested under.
 *
 * The OpenAI-compatible route lists OpenAI models unprefixed (`gpt-5.2`) while
 * the native catalog namespaces them (`openai/gpt-5.2`), and Merge publishes
 * floating aliases (`deepseek/deepseek-v4-flash-latest`). All of them resolve to
 * the same upstream, so all of them get the same facts.
 */
export function mergeNativeFactsIndex(
  entries: readonly unknown[],
): Map<string, Record<string, unknown>> {
  const index = new Map<string, Record<string, unknown>>();
  for (const raw of entries) {
    const entry = raw as MergeNativeEntry;
    const id = typeof entry.model === "string" ? entry.model.trim() : "";
    if (!id) continue;
    const facts = nativeFacts(entry);
    const ids = [id, ...aliasIds(entry)];
    const bare = id.startsWith("openai/") ? id.slice("openai/".length) : undefined;
    if (bare) ids.push(bare);
    for (const key of ids) index.set(key.toLowerCase(), facts);
  }
  return index;
}

/** Pairs each callable chat id with its published facts, or nothing extra when unknown. */
export function mergeCatalogEntries(
  chatModels: readonly unknown[],
  factsIndex: Map<string, Record<string, unknown>>,
): unknown[] {
  return chatModels.map((entry) => {
    const id =
      typeof entry === "string"
        ? entry
        : typeof (entry as MergeModelEntry).id === "string"
          ? ((entry as MergeModelEntry).id as string)
          : "";
    const facts = factsIndex.get(id.trim().toLowerCase());
    return facts ? { id, ...facts } : (entry as unknown);
  });
}

let cachedModels: string[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

export function resetMergeGatewayCatalogCache(): void {
  cachedModels = null;
  lastFetchTime = 0;
}

export function mergeGatewayAuthHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}`, "x-api-key": apiKey };
}

function requireKey(auth: ProviderAuth): string {
  if (!auth.apiKey) throw new Error("Merge Gateway API key is required");
  return auth.apiKey;
}

async function getJson<T>(
  url: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    headers: mergeGatewayAuthHeaders(apiKey),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return readJson<T>(response);
}

/**
 * Reads the native catalog, which is the only endpoint that publishes per-model
 * reasoning metadata. `/v1/openai/models` returns bare ids, which is why clai
 * previously had to guess reasoning support from model-name patterns.
 */
async function fetchNativeFacts(
  apiKey: string,
  signal?: AbortSignal,
): Promise<Map<string, Record<string, unknown>>> {
  const entries: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < NATIVE_CATALOG_MAX_PAGES; page += 1) {
    const query = `?limit=${NATIVE_CATALOG_PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const data = await getJson<{
      data?: unknown[];
      has_more?: boolean;
      next_cursor?: string | null;
    }>(`${GATEWAY_ROOT}/models${query}`, apiKey, signal);
    if (Array.isArray(data.data)) entries.push(...data.data);
    if (data.has_more !== true || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return mergeNativeFactsIndex(entries);
}

async function fetchCatalog(apiKey: string, signal?: AbortSignal): Promise<string[]> {
  const data = await getJson<{ data?: MergeModelEntry[] }>(
    `${mergeGatewayBaseUrl}/models`,
    apiKey,
    signal,
  );
  const chatModels = chatModelsFromCatalog(data);
  // Facts are a best-effort enrichment: if the native catalog is unavailable the
  // ids still register, and capability detection degrades to the name patterns.
  let factsIndex = new Map<string, Record<string, unknown>>();
  try {
    factsIndex = await fetchNativeFacts(apiKey, signal);
  } catch {
    factsIndex = new Map();
  }
  return ingestOpenAiModelCatalog(
    "merge-gateway",
    mergeCatalogEntries(chatModels, factsIndex),
  );
}

export const mergeGatewayProvider: LlmProvider = {
  id: "merge-gateway",
  reasoningStyle: "openai",
  displayName: "Merge Gateway",
  defaultModel: defaultModels["merge-gateway"],
  envVar: "MERGE_GATEWAY_API_KEY",
  validateKey: (key: string) => /^mg_[A-Za-z0-9_-]{8,}$/.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    const now = Date.now();
    if (cachedModels && now - lastFetchTime < CACHE_TTL_MS) return cachedModels;
    if (!auth.apiKey) return cachedModels ?? mergeGatewayFallbackModels;
    try {
      const models = await fetchCatalog(auth.apiKey);
      if (models.length > 0) {
        cachedModels = models;
        lastFetchTime = now;
        return models;
      }
      return cachedModels ?? mergeGatewayFallbackModels;
    } catch {
      return cachedModels ?? mergeGatewayFallbackModels;
    }
  },
  async ping(auth: ProviderAuth): Promise<void> {
    await openAiCompatiblePing(mergeGatewayBaseUrl, requireKey(auth));
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    const apiKey = requireKey(auth);
    const model = request.model ?? defaultModels["merge-gateway"];
    const payload = await openAiCompatibleComplete({
      provider: "Merge Gateway",
      providerId: "merge-gateway",
      baseUrl: mergeGatewayBaseUrl,
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
    });
    return toCompletionResult("merge-gateway", model, payload);
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    const apiKey = requireKey(auth);
    const model = request.model ?? defaultModels["merge-gateway"];
    const payload = await openAiCompatibleStream({
      provider: "Merge Gateway",
      providerId: "merge-gateway",
      baseUrl: mergeGatewayBaseUrl,
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
    });
    return toCompletionResult("merge-gateway", model, payload);
  },
};
