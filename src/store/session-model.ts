import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fixOwner, handlePermissionError, safeExists } from "../os/permissions.js";
import { getDataDir } from "./paths.js";
import { getConfig, getProviderModel } from "./config.js";
import { resolveFreeDefaultModel } from "../llm/free-default-model.js";
import type { ProviderId } from "../types.js";

const FREE_PROVIDER: ProviderId = "free";
const LAST_USED_SCAN_LIMIT = 32;

export interface SessionModelBinding {
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
}

export interface ResolvedSessionModel {
  readonly provider: ProviderId;
  readonly model: string;
}

interface SessionModelState {
  readonly bound: boolean;
  readonly binding: SessionModelBinding;
}

const UNBOUND: SessionModelState = Object.freeze({ bound: false, binding: {} });

const sessionBindings = new Map<string, SessionModelState>();
const sessionMutations = new Map<string, Promise<void>>();

function queueSessionMutation(
  sessionId: string,
  mutation: () => Promise<void>,
): Promise<void> {
  const previous = sessionMutations.get(sessionId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(mutation);
  sessionMutations.set(sessionId, next);
  void next
    .finally(() => {
      if (sessionMutations.get(sessionId) === next) sessionMutations.delete(sessionId);
    })
    .catch(() => undefined);
  return next;
}

function sessionModelDir(): string {
  return process.env.CLAI_SESSION_MODEL_DIR?.trim() || join(getDataDir(), "session-models");
}

export function getSessionModelPath(sessionId: string): string {
  return join(sessionModelDir(), `${encodeURIComponent(sessionId)}.json`);
}

function normalizeField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256) return undefined;
  return trimmed;
}

function sanitizeBinding(value: unknown): SessionModelBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const provider = normalizeField(raw.provider);
  const model = normalizeField(raw.model);
  return {
    ...(provider ? { provider: provider as ProviderId } : {}),
    ...(model ? { model } : {}),
  };
}

function hasBinding(binding: SessionModelBinding): boolean {
  return binding.provider !== undefined || binding.model !== undefined;
}

async function readSessionModelState(sessionId: string): Promise<SessionModelState> {
  const cached = sessionBindings.get(sessionId);
  if (cached) return cached;
  const file = getSessionModelPath(sessionId);
  let state: SessionModelState = UNBOUND;
  try {
    if (await safeExists(file)) {
      const raw = await readFile(file, "utf8");
      if (raw.trim()) {
        const parsed = JSON.parse(raw) as { binding?: unknown };
        const binding = sanitizeBinding(parsed?.binding);
        state = hasBinding(binding) ? { bound: true, binding } : UNBOUND;
      }
    }
  } catch (err: any) {
    if (err && err.code === "EACCES") handlePermissionError(err);
    return UNBOUND;
  }
  sessionBindings.set(sessionId, state);
  return state;
}

async function persistSessionModelState(
  sessionId: string,
  binding: SessionModelBinding,
): Promise<void> {
  const file = getSessionModelPath(sessionId);
  const temporary = `${file}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  try {
    const dir = dirname(file);
    await mkdir(dir, { recursive: true });
    await fixOwner(dir);
    const envelope = {
      version: 1,
      sessionId,
      binding,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, file);
    await fixOwner(file);
  } catch (err: any) {
    await rm(temporary, { force: true }).catch(() => undefined);
    handlePermissionError(err);
  }
  sessionBindings.set(
    sessionId,
    hasBinding(binding) ? { bound: true, binding } : UNBOUND,
  );
}

function writeSessionModelState(
  sessionId: string,
  binding: SessionModelBinding,
): Promise<void> {
  return queueSessionMutation(sessionId, () =>
    persistSessionModelState(sessionId, binding),
  );
}

export async function loadSessionModelBinding(
  sessionId: string | undefined,
): Promise<SessionModelBinding | undefined> {
  if (!sessionId) return undefined;
  const state = await readSessionModelState(sessionId);
  return state.bound ? state.binding : undefined;
}

export function globalModelDefaults(): ResolvedSessionModel {
  const config = getConfig();
  const provider = config.defaultProvider;
  const model = config.defaultModel || getProviderModel(provider);
  return { provider, model };
}

interface DatedBinding {
  readonly binding: SessionModelBinding;
  readonly at: number;
}

async function readDatedBinding(file: string): Promise<DatedBinding | undefined> {
  try {
    const raw = await readFile(file, "utf8");
    if (!raw.trim()) return undefined;
    const parsed = JSON.parse(raw) as { binding?: unknown; updatedAt?: unknown };
    const binding = sanitizeBinding(parsed?.binding);
    if (!hasBinding(binding)) return undefined;
    const stamp =
      typeof parsed?.updatedAt === "string" ? Date.parse(parsed.updatedAt) : Number.NaN;
    return { binding, at: Number.isFinite(stamp) ? stamp : 0 };
  } catch {
    return undefined;
  }
}

async function candidateFiles(exclude: string | undefined): Promise<string[]> {
  const dir = sessionModelDir();
  const excluded = exclude ? `${encodeURIComponent(exclude)}.json` : undefined;
  const names = await readdir(dir).catch(() => [] as string[]);
  const dated: Array<{ file: string; mtime: number }> = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name === excluded) continue;
    const file = join(dir, name);
    const info = await stat(file).catch(() => undefined);
    if (info) dated.push({ file, mtime: info.mtimeMs });
  }
  return dated
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, LAST_USED_SCAN_LIMIT)
    .map((entry) => entry.file);
}

export async function lastUsedSessionModel(
  exclude?: string | undefined,
): Promise<SessionModelBinding | undefined> {
  let best: DatedBinding | undefined;
  for (const file of await candidateFiles(exclude)) {
    const found = await readDatedBinding(file);
    if (found && (!best || found.at > best.at)) best = found;
  }
  return best?.binding;
}

export async function loadModelForSession(
  sessionId: string | undefined,
): Promise<ResolvedSessionModel> {
  const fallback = globalModelDefaults();
  const binding = await loadSessionModelBinding(sessionId);
  if (!binding) return fallback;
  const provider = binding.provider ?? fallback.provider;
  const model = binding.model ?? getProviderModel(provider);
  return { provider, model };
}

export interface SessionModelSeed {
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
  readonly modelExplicit?: boolean | undefined;
  readonly inheritLastUsed?: boolean | undefined;
  readonly freeCatalogFallback?: boolean | undefined;
}

export async function seedSessionModel(
  sessionId: string | undefined,
  fallback: SessionModelSeed,
): Promise<{ provider: ProviderId | undefined; model: string | undefined }> {
  const binding = await loadSessionModelBinding(sessionId);
  if (!binding) return seedFreshSession(sessionId, fallback);
  const provider = binding.provider ?? fallback.provider;
  return {
    provider,
    model:
      binding.model ??
      (binding.provider ? getProviderModel(binding.provider) : fallback.model),
  };
}

function pairFor(
  provider: ProviderId,
  model: string | undefined,
): { provider: ProviderId; model: string } {
  return { provider, model: model ?? getProviderModel(provider) };
}

async function seedFreshSession(
  sessionId: string | undefined,
  fallback: SessionModelSeed,
): Promise<{ provider: ProviderId | undefined; model: string | undefined }> {
  if (fallback.provider) return pairFor(fallback.provider, fallback.model);
  const inherited = fallback.inheritLastUsed
    ? await lastUsedSessionModel(sessionId)
    : undefined;
  if (inherited?.provider) {
    const model = fallback.modelExplicit ? fallback.model : inherited.model;
    return pairFor(inherited.provider, model);
  }
  if (!fallback.freeCatalogFallback || fallback.modelExplicit) {
    return { provider: fallback.provider, model: fallback.model };
  }
  return pairFor(FREE_PROVIDER, await resolveFreeDefaultModel());
}

export async function saveSessionModel(
  sessionId: string,
  binding: SessionModelBinding,
): Promise<void> {
  await writeSessionModelState(sessionId, sanitizeBinding(binding));
}

export async function clearSessionModel(sessionId: string): Promise<void> {
  await writeSessionModelState(sessionId, {});
}

export function releaseSessionModel(sessionId: string): Promise<void> {
  return queueSessionMutation(sessionId, async () => {
    sessionBindings.delete(sessionId);
    await rm(getSessionModelPath(sessionId), { force: true }).catch(() => undefined);
  });
}

export function resetSessionModelCache(): void {
  sessionBindings.clear();
}
