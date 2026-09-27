import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../store/paths.js";

const STORE_VERSION = 1;
const MAX_REMEMBERED_ROUTES = 4_000;

export interface RememberedModelLimits {
  readonly contextTokens: number;
  readonly maxOutputTokens?: number | undefined;
}

export interface ModelLimitObservation {
  readonly model: string;
  readonly contextTokens?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
}

const remembered = new Map<string, RememberedModelLimits>();
let loaded = false;

function storeFile(): string {
  return join(getDataDir(), "model-context-limits.json");
}

function routeKey(provider: string, model: string): string {
  return `${provider}:${model.trim().toLowerCase()}`;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const floored = Math.floor(value);
  return floored > 0 ? floored : undefined;
}

function limitsEntry(
  contextTokens: number,
  maxOutputTokens: number | undefined,
): RememberedModelLimits {
  return maxOutputTokens === undefined
    ? { contextTokens }
    : { contextTokens, maxOutputTokens };
}

function parseEntry(value: unknown): RememberedModelLimits | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const contextTokens = positiveInteger(record.contextTokens);
  if (contextTokens === undefined) return undefined;
  return limitsEntry(contextTokens, positiveInteger(record.maxOutputTokens));
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(readFileSync(storeFile(), "utf8")) as {
      version?: unknown;
      entries?: unknown;
    };
    if (parsed.version !== STORE_VERSION) return;
    if (!parsed.entries || typeof parsed.entries !== "object") return;
    for (const [key, value] of Object.entries(parsed.entries)) {
      const entry = parseEntry(value);
      if (entry) remembered.set(key, entry);
    }
  } catch {}
}

function trimToCapacity(): void {
  const excess = remembered.size - MAX_REMEMBERED_ROUTES;
  if (excess <= 0) return;
  for (const key of [...remembered.keys()].slice(0, excess)) remembered.delete(key);
}

function persist(): void {
  const file = storeFile();
  const temp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(getDataDir(), { recursive: true });
    const entries = Object.fromEntries(remembered);
    writeFileSync(temp, `${JSON.stringify({ version: STORE_VERSION, entries })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temp, file);
  } catch {
    try {
      rmSync(temp, { force: true });
    } catch {}
  }
}

export function rememberModelLimits(
  provider: string,
  observations: readonly ModelLimitObservation[],
): void {
  load();
  let changed = false;
  for (const observation of observations) {
    const contextTokens = positiveInteger(observation.contextTokens);
    if (contextTokens === undefined || !observation.model.trim()) continue;
    const maxOutputTokens = positiveInteger(observation.maxOutputTokens);
    const key = routeKey(provider, observation.model);
    const previous = remembered.get(key);
    if (
      previous?.contextTokens === contextTokens &&
      previous.maxOutputTokens === maxOutputTokens
    ) {
      continue;
    }
    remembered.delete(key);
    remembered.set(key, limitsEntry(contextTokens, maxOutputTokens));
    changed = true;
  }
  if (!changed) return;
  trimToCapacity();
  persist();
}

export function rememberedModelLimits(
  provider: string,
  model: string,
): RememberedModelLimits | undefined {
  if (!model.trim()) return undefined;
  load();
  return remembered.get(routeKey(provider, model));
}

export function reloadRememberedModelLimits(): void {
  remembered.clear();
  loaded = false;
}

export function resetRememberedModelLimits(options?: {
  readonly removePersisted?: boolean | undefined;
}): void {
  remembered.clear();
  loaded = true;
  if (!options?.removePersisted) return;
  try {
    rmSync(storeFile(), { force: true });
  } catch {}
}
