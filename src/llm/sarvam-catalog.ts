import { createHash } from "node:crypto";
import { registerModelCatalog, registerModelCatalogLimits } from "./capabilities.js";
import { registerKnownSecret } from "../security/known-secrets.js";
import { scopedCatalogRouteKey, scopedModelCatalogFacts, withModelCatalogFacts } from "./catalog-context.js";
import type { CatalogFacts } from "./catalog-facts.js";
import { ProviderError, readJson } from "./http.js";
import { isImmediateKeySwitchError } from "./key-rotation.js";
import { modelListCache, onModelListInvalidated, type ModelListCache } from "./model-list-cache.js";
import { normalizeEndpointUrl, type ProviderAuth } from "./provider.js";
import { mergeSarvamModelFacts, parseSarvamModel, SARVAM_BASE_URL, sarvamModelFacts } from "./sarvam-models.js";
import { currentIsolatedSessionAffinity } from "./session-affinity.js";

const LIST_TIMEOUT_MS = 12_000;
const DETAIL_TIMEOUT_MS = 3_000;
const DETAIL_BATCH_SIZE = 5;
const NON_CHAT_MODEL = /^(?:clef|embeddinggemma|sarvam-prism)(?:-|$)/i;

interface SarvamCredentials {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly cacheKey: string;
}

export function sarvamCredentials(auth: ProviderAuth): SarvamCredentials {
  const apiKey = auth.apiKey?.trim();
  if (!apiKey) throw new Error("Sarvam Token Factory API key is required");
  registerKnownSecret(apiKey);
  const baseUrl = normalizeEndpointUrl(auth.baseUrl ?? process.env.SARVAM_BASE_URL ?? "", "sarvam") || SARVAM_BASE_URL;
  const cacheKey = createHash("sha256").update(JSON.stringify([baseUrl, apiKey])).digest("hex");
  return { baseUrl, apiKey, cacheKey };
}

export function sarvamAuthHeaders(apiKey: string): Record<string, string> {
  return { "api-subscription-key": apiKey };
}

function metadataCache<T>(cache: ModelListCache<T>) {
  const pending = new Map<string, Promise<T>>();
  onModelListInvalidated("sarvam", () => pending.clear());
  return {
    fresh(key: string) {
      return cache.fresh(key);
    },
    stale(key: string) {
      return cache.stale(key);
    },
    load(key: string, fetchValue: () => Promise<T>): Promise<T> {
      const fresh = cache.fresh(key);
      if (fresh !== undefined) return Promise.resolve(fresh);
      const inFlight = pending.get(key);
      if (inFlight) return inFlight;
      const task = fetchValue().then((value) => {
        if (pending.get(key) === task) cache.store(value, key);
        return value;
      }).finally(() => {
        if (pending.get(key) === task) pending.delete(key);
      });
      pending.set(key, task);
      return task;
    },
  };
}

const lists = metadataCache(modelListCache<CatalogFacts[]>("sarvam"));
const details = metadataCache(modelListCache<CatalogFacts>("sarvam"));

async function fetchMetadata(
  credentials: SarvamCredentials,
  path: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`${credentials.baseUrl}${path}`, {
    headers: { accept: "application/json", ...sarvamAuthHeaders(credentials.apiKey) },
    redirect: "error",
    signal,
  });
  return readJson<unknown>(response, signal);
}

async function fetchModelList(credentials: SarvamCredentials): Promise<CatalogFacts[]> {
  const payload = await fetchMetadata(credentials, "/models", AbortSignal.timeout(LIST_TIMEOUT_MS));
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("Sarvam Token Factory returned an invalid model catalog");
  const models = new Map<string, CatalogFacts>();
  for (const entry of data) {
    const model = parseSarvamModel(entry);
    if (model && !NON_CHAT_MODEL.test(model.id)) models.set(model.id, model);
  }
  return [...models.values()];
}

async function loadModel(
  credentials: SarvamCredentials,
  model: string,
  signal = AbortSignal.timeout(DETAIL_TIMEOUT_MS),
): Promise<CatalogFacts | undefined> {
  const key = `${credentials.cacheKey}:${model}`;
  try {
    return await details.load(key, async () => {
      const payload = await fetchMetadata(credentials, `/models/${encodeURIComponent(model)}`, signal);
      const facts = parseSarvamModel(payload);
      if (facts?.id !== model) throw new Error("Sarvam Token Factory returned mismatched model metadata");
      return facts;
    });
  } catch (error) {
    if (isImmediateKeySwitchError(error)) throw error;
    if (error instanceof ProviderError && error.status === 404) return undefined;
    return details.stale(key);
  }
}

function missingMetadata(facts: CatalogFacts): boolean {
  return facts.contextTokens === undefined || facts.vision === undefined || facts.tools === undefined ||
    (facts.reasoning?.supported !== false && facts.reasoning?.supportedEfforts === undefined);
}

async function enrichModelList(credentials: SarvamCredentials): Promise<CatalogFacts[]> {
  const models = await fetchModelList(credentials);
  const signal = AbortSignal.timeout(DETAIL_TIMEOUT_MS);
  for (let start = 0; start < models.length && !signal.aborted; start += DETAIL_BATCH_SIZE) {
    const batch = models.slice(start, start + DETAIL_BATCH_SIZE);
    const enriched = await Promise.all(batch.map(async (facts) =>
      missingMetadata(facts) && !signal.aborted
        ? mergeSarvamModelFacts(facts, await loadModel(credentials, facts.id, signal))
        : facts,
    ));
    models.splice(start, batch.length, ...enriched);
  }
  return models;
}

export async function listSarvamModels(auth: ProviderAuth): Promise<string[]> {
  const credentials = sarvamCredentials(auth);
  const models = await lists.load(credentials.cacheKey, () => enrichModelList(credentials));
  if (lists.fresh(credentials.cacheKey) === models) {
    registerModelCatalog("sarvam", models.map((facts) => ({
      id: facts.id,
      facts,
      vision: sarvamModelFacts(facts.id, facts)?.vision,
    })));
  }
  return models.map(({ id }) => id);
}

export async function pingSarvam(auth: ProviderAuth): Promise<void> {
  await fetchModelList(sarvamCredentials(auth));
}

function withAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

export async function withSarvamModelMetadata<T>(
  model: string,
  auth: ProviderAuth,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const credentials = sarvamCredentials(auth);
  if (scopedCatalogRouteKey("sarvam") === credentials.cacheKey &&
      scopedModelCatalogFacts("sarvam")?.has(model.toLowerCase())) return run();
  const cached = lists.fresh(credentials.cacheKey)?.find(({ id }) => id === model);
  const stale = lists.stale(credentials.cacheKey)?.find(({ id }) => id === model);
  const detail = cached ?? await withAbort(loadModel(credentials, model), signal);
  const facts = mergeSarvamModelFacts(stale ?? { id: model }, detail);
  signal?.throwIfAborted();
  const result = await withModelCatalogFacts("sarvam", [{ id: model, facts }], run, credentials.cacheKey);
  if ((stale || detail) && !currentIsolatedSessionAffinity()) {
    const current = lists.fresh(credentials.cacheKey)?.find(({ id }) => id === model);
    registerModelCatalogLimits("sarvam", [current ?? facts]);
  }
  return result;
}
