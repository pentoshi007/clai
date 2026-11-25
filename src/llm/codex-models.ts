import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDataDir } from "../store/paths.js";
import type { ProviderAuth } from "./provider.js";
import {
  CODEX_API_BASE_URL,
  CODEX_CLIENT_VERSION,
  codexRequestHeaders,
  type CodexCredential,
} from "./codex-auth.js";
import { credentialFor, withCodexCredential } from "./codex-credential.js";
import { catalogEffortList, catalogEntriesFromPayload } from "./catalog-facts.js";
import { registerModelCatalog } from "./capabilities.js";
import { ProviderError, readJson } from "./http.js";
import { isModelListFresh, MODEL_LIST_TTL_MS, onModelListInvalidated } from "./model-list-cache.js";
import { parseModelCatalogEntries } from "./wire/model-catalog.js";

const FAST_TIER = "priority";
const FAST_SUFFIX = "-fast";

const shippedFastModels = [
  "gpt-6.2-sol",
  "gpt-6.2-astra",
  "gpt-6.1-terra",
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
];

export const codexFallbackModels: readonly string[] = [
  ...shippedFastModels.flatMap((model) => [model, model + FAST_SUFFIX]),
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
];

export interface CodexModelMetadata {
  readonly id: string;
  readonly visibility?: string | undefined;
  readonly supportedEfforts: readonly string[];
  readonly defaultEffort?: string | undefined;
  readonly defaultSummary?: string | undefined;
  readonly supportsSummary: boolean;
  readonly supportsVerbosity: boolean;
  readonly defaultVerbosity?: string | undefined;
  readonly supportsParallelToolCalls: boolean;
  readonly responsesLite: boolean;
}

type CatalogEntry = Record<string, unknown> & { readonly id: string };

interface CatalogCache {
  readonly fetchedAt: number;
  readonly entries: readonly CatalogEntry[];
  readonly etag?: string | undefined;
}

const catalogs = new Map<string, CatalogCache>();
const pending = new Map<string, Promise<string[]>>();
let readDiskCache = true;

onModelListInvalidated("codex", () => {
  for (const [key, catalog] of catalogs) catalogs.set(key, { ...catalog, fetchedAt: 0 });
  pending.clear();
});

function catalogKey(credential: CodexCredential): string {
  return createHash("sha256")
    .update(JSON.stringify([
      CODEX_API_BASE_URL,
      CODEX_CLIENT_VERSION,
      credential.accountId,
      credential.residency,
    ]))
    .digest("hex");
}

function stringField(entry: CatalogEntry, name: string): string | undefined {
  const value = entry[name];
  return typeof value === "string" ? value : undefined;
}

function normalizeEntries(payload: unknown): CatalogEntry[] {
  return catalogEntriesFromPayload(payload).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const entry = value as Record<string, unknown>;
    const id = entry.slug ?? entry.id ?? entry.name;
    if (typeof id !== "string" || !id.trim()) return [];
    const context = entry.context_window ?? entry.max_context_window;
    const effectivePercentage = entry.effective_context_window_percent;
    const percentage = typeof effectivePercentage === "number"
      && effectivePercentage > 0 && effectivePercentage <= 100
      ? effectivePercentage : 95;
    const { model_messages: _messages, base_instructions: _instructions, ...metadata } = entry;
    return [{
      ...metadata,
      id: id.trim(),
      ...(typeof context === "number" && Number.isFinite(context) && context > 0
        ? {
          context_window: context,
          top_provider: { context_length: Math.floor(context * percentage / 100) },
        }
        : {}),
    }];
  });
}

function supportsFast(entry: CatalogEntry): boolean | undefined {
  if (Array.isArray(entry.service_tiers)) {
    return entry.service_tiers.some((tier) => tier?.id === FAST_TIER);
  }
  if (Array.isArray(entry.additional_speed_tiers)) {
    return entry.additional_speed_tiers.includes("fast");
  }
  return undefined;
}

function catalogPriority(entry: CatalogEntry): number {
  return typeof entry.priority === "number" && Number.isFinite(entry.priority)
    ? entry.priority
    : Number.MAX_SAFE_INTEGER;
}

function activateCatalog(cache: CatalogCache): string[] {
  const models = new Map(parseModelCatalogEntries(cache.entries).map((model) => [model.id, model]));
  const listed = new Set<string>();
  const visible = cache.entries
    .filter((entry) => entry.visibility === undefined || entry.visibility === "list")
    .sort((left, right) => catalogPriority(left) - catalogPriority(right) || left.id.localeCompare(right.id));
  for (const entry of visible) {
    listed.add(entry.id);
    const alias = entry.id + FAST_SUFFIX;
    const base = models.get(entry.id);
    if (!base?.facts || models.has(alias) || !supportsFast(entry)) continue;
    models.set(alias, { ...base, id: alias, facts: { ...base.facts, id: alias, canonicalModel: entry.id } });
    listed.add(alias);
  }
  registerModelCatalog("codex", [...models.values()]);
  return [...listed];
}

function codexCatalogEntry(credential: CodexCredential, model: string): CatalogEntry | undefined {
  return catalogs.get(catalogKey(credential))?.entries.find((entry) => entry.id === model);
}

export function codexModelRoute(
  credential: CodexCredential,
  selected: string,
): { model: string; serviceTier?: string } {
  if (selected.length <= FAST_SUFFIX.length || !selected.endsWith(FAST_SUFFIX) || codexCatalogEntry(credential, selected)) {
    return { model: selected };
  }
  const model = selected.slice(0, -FAST_SUFFIX.length);
  const entry = codexCatalogEntry(credential, model);
  if (entry && supportsFast(entry) === false) {
    throw new ProviderError(`ChatGPT Fast mode is unavailable for ${model}.`, 400);
  }
  return { model, serviceTier: FAST_TIER };
}

export function codexModelMetadata(
  credential: CodexCredential,
  model: string,
): CodexModelMetadata | undefined {
  const entry = codexCatalogEntry(credential, model);
  if (!entry) return undefined;
  const levels = Array.isArray(entry.supported_reasoning_levels)
    ? entry.supported_reasoning_levels : [];
  const supportedEfforts = catalogEffortList(levels.flatMap((level) => {
    if (typeof level === "string") return [level];
    if (level && typeof level === "object" && typeof level.effort === "string") {
      return [level.effort as string];
    }
    return [];
  })) ?? [];
  return {
    id: model,
    visibility: stringField(entry, "visibility"),
    supportedEfforts,
    defaultEffort: stringField(entry, "default_reasoning_level"),
    defaultSummary: stringField(entry, "default_reasoning_summary"),
    supportsSummary: entry.supports_reasoning_summary_parameter !== false,
    supportsVerbosity: entry.support_verbosity === true,
    defaultVerbosity: stringField(entry, "default_verbosity"),
    supportsParallelToolCalls: entry.supports_parallel_tool_calls !== false,
    responsesLite: entry.use_responses_lite === true,
  };
}

async function fetchCatalog(
  auth: ProviderAuth,
  key: string,
  maxAgeMs: number,
): Promise<string[]> {
  const path = join(getDataDir(), "codex-models", `${key}.json`);
  let cached = catalogs.get(key);
  if (!cached && readDiskCache) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as CatalogCache;
      if (Number.isFinite(parsed.fetchedAt) && Array.isArray(parsed.entries)) {
        cached = { ...parsed, entries: normalizeEntries(parsed.entries) };
        catalogs.set(key, cached);
      }
    } catch {}
  }
  if (cached && isModelListFresh(cached.fetchedAt, maxAgeMs)) return activateCatalog(cached);
  try {
    const updated = await withCodexCredential(auth, async (credential): Promise<CatalogCache> => {
      const response = await fetch(`${CODEX_API_BASE_URL}/models?client_version=${CODEX_CLIENT_VERSION}`, {
        headers: {
          authorization: `Bearer ${credential.accessToken}`,
          ...codexRequestHeaders(credential.accountId, {}, credential.residency),
          ...(cached?.etag ? { "if-none-match": cached.etag } : {}),
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 304 && cached) return { ...cached, fetchedAt: Date.now() };
      const payload = await readJson<unknown>(response);
      const entries = normalizeEntries(payload);
      if (!entries.length) throw new Error("ChatGPT returned an empty model catalog");
      return { fetchedAt: Date.now(), entries, etag: response.headers.get("etag") ?? undefined };
    });
    catalogs.set(key, updated);
    const result = activateCatalog(updated);
    try {
      await mkdir(join(getDataDir(), "codex-models"), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(updated), { mode: 0o600 });
      await rename(temporary, path);
    } catch {}
    return result;
  } catch (error) {
    if (cached) return activateCatalog(cached);
    throw error;
  }
}

export async function listCodexModels(
  auth: ProviderAuth,
  maxAgeMs: number = MODEL_LIST_TTL_MS,
): Promise<string[]> {
  const key = catalogKey(credentialFor(auth));
  const cached = catalogs.get(key);
  if (cached && isModelListFresh(cached.fetchedAt, maxAgeMs)) return activateCatalog(cached);
  const existing = pending.get(key);
  if (existing) return existing;
  const task = fetchCatalog(auth, key, maxAgeMs);
  pending.set(key, task);
  try {
    return await task;
  } finally {
    pending.delete(key);
  }
}

export function resetCodexModelCache(): void {
  catalogs.clear();
  pending.clear();
  readDiskCache = false;
}
