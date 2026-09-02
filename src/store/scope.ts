import { mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { fixOwner, handlePermissionError, safeExists } from "../os/permissions.js";

import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import net from "node:net";
import { getDataDir } from "./paths.js";

const scopeFile =
  process.env.CLAI_SCOPE_FILE ??
  (process.env.VITEST_WORKER_ID
    ? join(tmpdir(), `clai-scope-${process.env.VITEST_WORKER_ID}.json`)
    : join(homedir(), ".clai", "scope.json"));

export interface EngagementScope {
  name?: string | undefined;
  authorizedTargets: string[];
  excludedTargets?: string[] | undefined;
  allowedPhases?: Array<"recon" | "enumeration" | "authentication" | "exploitation" | "post-exploitation"> | undefined;
  allowedPorts?: number[] | undefined;
  allowedPaths?: string[] | undefined;
  allowedMethods?: string[] | undefined;
  maxRate?: number | undefined;
  maxConcurrency?: number | undefined;
  authorizationNote?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  expiresAt?: string | undefined;
}

let cached: EngagementScope | undefined;
let cacheLoaded = false;
let cachedMtimeMs = 0;

export async function loadScope(): Promise<EngagementScope | undefined> {
  try {
    if (!(await safeExists(scopeFile))) {
      cached = undefined;
      cacheLoaded = true;
      cachedMtimeMs = 0;
      return undefined;
    }
    const st = await stat(scopeFile);
    const mtime = st.mtimeMs;
    if (cacheLoaded && mtime === cachedMtimeMs) {
      return cached;
    }
    const raw = await readFile(scopeFile, "utf8");
    if (!raw.trim()) {
      cached = undefined;
    } else {
      cached = JSON.parse(raw) as EngagementScope;
    }
    cacheLoaded = true;
    cachedMtimeMs = mtime;
    return cached;
  } catch (err: any) {
    if (err && err.code === "EACCES") {
      handlePermissionError(err);
    }
    return cached;
  }
}

export async function saveScope(scope: EngagementScope): Promise<void> {
  try {
    const dir = dirname(scopeFile);
    await mkdir(dir, { recursive: true });
    await fixOwner(dir);
    await writeFile(scopeFile, `${JSON.stringify(scope, null, 2)}\n`, { mode: 0o600 });
    await fixOwner(scopeFile);
    cached = scope;
    cacheLoaded = true;
    try {
      const st = await stat(scopeFile);
      cachedMtimeMs = st.mtimeMs;
    } catch {
      cachedMtimeMs = Date.now();
    }
  } catch (err: any) {
    handlePermissionError(err);
  }
}

export function normalizeScopeTarget(target: string): string {
  const trimmed = target.trim();
  if (!trimmed) return "";
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      return new URL(trimmed).hostname.toLowerCase();
    }
  } catch {
  }

  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(trimmed);
  if (bracketed?.[1] && net.isIP(bracketed[1])) {
    return bracketed[1].toLowerCase();
  }

  const cidr = /^(?:\[([^\]]+)\]|([^/]+))\/(\d{1,3})$/.exec(trimmed);
  const cidrHost = cidr?.[1] ?? cidr?.[2];
  if (cidrHost && cidr?.[3]) {
    const version = net.isIP(cidrHost);
    const prefix = Number(cidr[3]);
    const maxPrefix = version === 4 ? 32 : version === 6 ? 128 : -1;
    if (prefix >= 0 && prefix <= maxPrefix) {
      return `${cidrHost.toLowerCase()}/${prefix}`;
    }
  }

  if (net.isIP(trimmed)) return trimmed.toLowerCase();
  const withoutPath = trimmed.split(/[/?#]/)[0] ?? trimmed;
  if (net.isIP(withoutPath)) return withoutPath.toLowerCase();
  return withoutPath.replace(/:\d+$/, "").toLowerCase();
}

export async function addScopeTargets(
  targets: string[],
  patch: Partial<Omit<EngagementScope, "authorizedTargets">> = {},
): Promise<EngagementScope> {
  const normalized = targets
    .map(normalizeScopeTarget)
    .filter((target) => target.length > 0);
  if (normalized.length === 0) {
    throw new Error("No valid targets supplied");
  }

  const existing = await loadScope();
  const authorizedTargets = Array.from(
    new Set([
      ...(existing?.authorizedTargets ?? []).map(normalizeScopeTarget),
      ...normalized,
    ]),
  ).filter(Boolean);
  const now = new Date().toISOString();
  const scope: EngagementScope = {
    ...(existing ?? {}),
    ...patch,
    authorizedTargets,
    createdAt: existing?.createdAt ?? patch.createdAt ?? now,
    updatedAt: now,
  };
  await saveScope(scope);
  return scope;
}

export async function replaceScopeTargets(
  targets: string[],
  patch: Partial<Omit<EngagementScope, "authorizedTargets">> = {},
): Promise<EngagementScope | undefined> {
  const normalized = targets
    .map(normalizeScopeTarget)
    .filter((target) => target.length > 0);
  if (normalized.length === 0) {
    await clearScope();
    return undefined;
  }
  const existing = await loadScope();
  const now = new Date().toISOString();
  const scope: EngagementScope = {
    ...(existing ?? {}),
    ...patch,
    authorizedTargets: Array.from(new Set(normalized)),
    createdAt: existing?.createdAt ?? patch.createdAt ?? now,
    updatedAt: now,
  };
  await saveScope(scope);
  return scope;
}

export async function clearScope(): Promise<void> {
  cached = undefined;
  cacheLoaded = true;
  if (await safeExists(scopeFile)) {
    await writeFile(scopeFile, "", "utf8");
  }
}

export function getScopePath(): string {
  return scopeFile;
}

export function resetScopeCache(): void {
  cached = undefined;
  cacheLoaded = false;
  cachedMtimeMs = 0;
  sessionBindings.clear();
}

interface SessionScopeBinding {
  readonly bound: boolean;
  readonly scope: EngagementScope | undefined;
}

const UNBOUND: SessionScopeBinding = Object.freeze({
  bound: false,
  scope: undefined,
});

const sessionBindings = new Map<string, SessionScopeBinding>();

function sessionScopeDir(): string {
  return process.env.CLAI_SCOPE_DIR?.trim() || join(getDataDir(), "scopes");
}

export function getSessionScopePath(sessionId: string): string {
  return join(sessionScopeDir(), `${encodeURIComponent(sessionId)}.json`);
}

function sanitizeScope(value: unknown): EngagementScope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const targets = Array.isArray(raw.authorizedTargets)
    ? raw.authorizedTargets.filter(
        (target): target is string => typeof target === "string" && target.trim() !== "",
      )
    : [];
  if (targets.length === 0) return undefined;
  return { ...(raw as unknown as EngagementScope), authorizedTargets: targets };
}

async function readSessionBinding(sessionId: string): Promise<SessionScopeBinding> {
  const cachedBinding = sessionBindings.get(sessionId);
  if (cachedBinding) return cachedBinding;
  const file = getSessionScopePath(sessionId);
  let binding: SessionScopeBinding = UNBOUND;
  try {
    if (await safeExists(file)) {
      const raw = await readFile(file, "utf8");
      if (raw.trim()) {
        const parsed = JSON.parse(raw) as { scope?: unknown };
        binding = { bound: true, scope: sanitizeScope(parsed?.scope) };
      }
    }
  } catch (err: any) {
    if (err && err.code === "EACCES") handlePermissionError(err);
    return UNBOUND;
  }
  sessionBindings.set(sessionId, binding);
  return binding;
}

async function writeSessionBinding(
  sessionId: string,
  scope: EngagementScope | undefined,
): Promise<void> {
  const file = getSessionScopePath(sessionId);
  try {
    const dir = dirname(file);
    await mkdir(dir, { recursive: true });
    await fixOwner(dir);
    const envelope = {
      version: 1,
      sessionId,
      scope: scope ?? null,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(file, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
    await fixOwner(file);
  } catch (err: any) {
    handlePermissionError(err);
  }
  sessionBindings.set(sessionId, { bound: true, scope });
}

export async function loadScopeForSession(
  sessionId: string | undefined,
): Promise<EngagementScope | undefined> {
  if (!sessionId) return loadScope();
  const binding = await readSessionBinding(sessionId);
  return binding.bound ? binding.scope : loadScope();
}

export async function saveSessionScope(
  sessionId: string,
  scope: EngagementScope,
): Promise<EngagementScope | undefined> {
  const normalized = sanitizeScope(scope);
  await writeSessionBinding(sessionId, normalized);
  return normalized;
}

export async function clearSessionScope(sessionId: string): Promise<void> {
  await writeSessionBinding(sessionId, undefined);
}

export async function releaseSessionScope(sessionId: string): Promise<void> {
  sessionBindings.delete(sessionId);
  const file = getSessionScopePath(sessionId);
  try {
    await rm(file, { force: true });
  } catch {
    return;
  }
}

export async function addSessionScopeTargets(
  sessionId: string,
  targets: string[],
  patch: Partial<Omit<EngagementScope, "authorizedTargets">> = {},
): Promise<EngagementScope> {
  const normalized = targets
    .map(normalizeScopeTarget)
    .filter((target) => target.length > 0);
  if (normalized.length === 0) {
    throw new Error("No valid targets supplied");
  }
  const existing = await loadScopeForSession(sessionId);
  const authorizedTargets = Array.from(
    new Set([
      ...(existing?.authorizedTargets ?? []).map(normalizeScopeTarget),
      ...normalized,
    ]),
  ).filter(Boolean);
  const now = new Date().toISOString();
  const scope: EngagementScope = {
    ...(existing ?? {}),
    ...patch,
    authorizedTargets,
    createdAt: existing?.createdAt ?? patch.createdAt ?? now,
    updatedAt: now,
  };
  await writeSessionBinding(sessionId, scope);
  return scope;
}

export async function replaceSessionScopeTargets(
  sessionId: string,
  targets: string[],
  patch: Partial<Omit<EngagementScope, "authorizedTargets">> = {},
): Promise<EngagementScope | undefined> {
  const normalized = targets
    .map(normalizeScopeTarget)
    .filter((target) => target.length > 0);
  if (normalized.length === 0) {
    await clearSessionScope(sessionId);
    return undefined;
  }
  const existing = await loadScopeForSession(sessionId);
  const now = new Date().toISOString();
  const scope: EngagementScope = {
    ...(existing ?? {}),
    ...patch,
    authorizedTargets: Array.from(new Set(normalized)),
    createdAt: existing?.createdAt ?? patch.createdAt ?? now,
    updatedAt: now,
  };
  await writeSessionBinding(sessionId, scope);
  return scope;
}

export function resetSessionScopeCache(): void {
  sessionBindings.clear();
}

export function isLoopbackScopeTarget(target: string): boolean {
  const n = normalizeScopeTarget(target);
  if (!n) return false;
  if (
    n === "localhost" ||
    n === "localhost.localdomain" ||
    n === "ip6-localhost" ||
    n === "ip6-loopback" ||
    n === "127.0.0.1" ||
    n === "::1" ||
    n === "0:0:0:0:0:0:0:1"
  ) {
    return true;
  }
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(n);
}

function ipInCidr(ip: string, cidr: string): boolean {
  const slash = cidr.lastIndexOf("/");
  if (slash <= 0) return false;
  const base = cidr.slice(0, slash);
  const prefix = Number(cidr.slice(slash + 1));
  const version = net.isIP(ip);
  if (!version || net.isIP(base) !== version) return false;
  const maxPrefix = version === 4 ? 32 : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) return false;
  try {
    const family = version === 4 ? "ipv4" : "ipv6";
    const block = new net.BlockList();
    block.addSubnet(base, prefix, family);
    return block.check(ip, family);
  } catch {
    return false;
  }
}

export function targetInScope(target: string, scope: EngagementScope): boolean {
  const trimmed = normalizeScopeTarget(target);
  if (!trimmed) return false;
  const excluded = (scope.excludedTargets ?? []).map(normalizeScopeTarget);
  if (excluded.some((entry) => matchEntry(trimmed, entry))) return false;
  if (isLoopbackScopeTarget(trimmed)) {
    if (
      scope.authorizedTargets.some((entry) =>
        isLoopbackScopeTarget(normalizeScopeTarget(entry)),
      )
    ) {
      return true;
    }
  }
  return scope.authorizedTargets.some((entry) => matchEntry(trimmed, normalizeScopeTarget(entry)));
}

function matchEntry(target: string, entry: string): boolean {
  if (entry === target) return true;
  if (entry.includes("/") && net.isIP(target)) {
    return ipInCidr(target, entry);
  }
  if (!net.isIP(target) && !entry.includes("/")) {
    return target === entry || target.endsWith(`.${entry}`);
  }
  return false;
}

export function isScopeActive(scope: EngagementScope | undefined): scope is EngagementScope {
  if (!scope) return false;
  if (!scope.authorizedTargets || scope.authorizedTargets.length === 0) return false;
  if (scope.expiresAt) {
    const expires = Date.parse(scope.expiresAt);
    if (!Number.isNaN(expires) && Date.now() > expires) return false;
  }
  return true;
}
