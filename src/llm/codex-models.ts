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
import { catalogEntriesFromPayload } from "./catalog-facts.js";
import { ingestModelCatalogEntries, readJson } from "./http.js";

export const codexFallbackModels: readonly string[] = [
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
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
  readonly responsesLite: boolean;
}

interface CatalogCache {
  readonly fetchedAt: number;
  readonly entries: readonly Record<string, unknown>[];
  readonly etag?: string | undefined;
}

const CACHE_TTL_MS = 5 * 60_000;
const catalogs = new Map<string, CatalogCache>();
const pending = new Map<string, Promise<string[]>>();
let readDiskCache = true;

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

function stringField(
  entry: Record<string, unknown>,
  name: string,
): string | undefined {
  return typeof entry[name] === "string" ? entry[name] as string : undefined;
}

function normalizeEntries(payload: unknown): Record<string, unknown>[] {
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

function activateCatalog(cache: CatalogCache): string[] {
  ingestModelCatalogEntries("codex", cache.entries);
  return cache.entries
    .filter((entry) => entry.visibility === undefined || entry.visibility === "list")
    .map((entry) => String(entry.id))
    .filter((id, index, ids) => ids.indexOf(id) === index)
    .sort();
}

export function codexModelMetadata(
  credential: CodexCredential,
  model: string,
): CodexModelMetadata | undefined {
  const entry = catalogs.get(catalogKey(credential))?.entries.find((entry) => entry.id === model);
  if (!entry) return undefined;
  const levels = Array.isArray(entry.supported_reasoning_levels)
    ? entry.supported_reasoning_levels : [];
  const supportedEfforts = levels.flatMap((level) => {
    if (typeof level === "string") return [level];
    if (level && typeof level === "object" && typeof level.effort === "string") {
      return [level.effort as string];
    }
    return [];
  });
  return {
    id: model,
    visibility: stringField(entry, "visibility"),
    supportedEfforts,
    defaultEffort: stringField(entry, "default_reasoning_level"),
    defaultSummary: stringField(entry, "default_reasoning_summary"),
    supportsSummary: entry.supports_reasoning_summary_parameter !== false,
    supportsVerbosity: entry.support_verbosity === true,
    defaultVerbosity: stringField(entry, "default_verbosity"),
    responsesLite: entry.use_responses_lite === true,
  };
}

async function fetchCatalog(auth: ProviderAuth, key: string): Promise<string[]> {
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
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return activateCatalog(cached);
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

export async function listCodexModels(auth: ProviderAuth): Promise<string[]> {
  const key = catalogKey(credentialFor(auth));
  const cached = catalogs.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return activateCatalog(cached);
  const existing = pending.get(key);
  if (existing) return existing;
  const task = fetchCatalog(auth, key);
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
