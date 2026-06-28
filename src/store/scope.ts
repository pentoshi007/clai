import { mkdir, readFile, writeFile, chown } from "node:fs/promises";
import { fixOwner, handlePermissionError, safeExists } from "../os/permissions.js";

import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import net from "node:net";

const scopeFile =
  process.env.CLAI_SCOPE_FILE ??
  (process.env.VITEST_WORKER_ID
    ? join(tmpdir(), `clai-scope-${process.env.VITEST_WORKER_ID}.json`)
    : join(homedir(), ".clai", "scope.json"));

export interface EngagementScope {
  name?: string | undefined;
  authorizedTargets: string[];
  excludedTargets?: string[] | undefined;
  allowedPhases?: Array<"recon" | "enumeration" | "exploitation" | "post-exploitation"> | undefined;
  maxRate?: number | undefined;
  maxConcurrency?: number | undefined;
  authorizationNote?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  expiresAt?: string | undefined;
}

let cached: EngagementScope | undefined;
let cacheLoaded = false;

export async function loadScope(): Promise<EngagementScope | undefined> {
  if (cacheLoaded) return cached;
  cacheLoaded = true;
  if (!(await safeExists(scopeFile))) return undefined;
  try {
    const raw = await readFile(scopeFile, "utf8");
    cached = JSON.parse(raw) as EngagementScope;
    return cached;
  } catch (err: any) {
    if (err && err.code === "EACCES") {
      handlePermissionError(err);
    }
    return undefined;
  }
}

export async function saveScope(scope: EngagementScope): Promise<void> {
  try {
    const dir = join(homedir(), ".clai");
    await mkdir(dir, { recursive: true });
    await fixOwner(dir);
    await writeFile(scopeFile, `${JSON.stringify(scope, null, 2)}\n`, { mode: 0o600 });
    await fixOwner(scopeFile);
    cached = scope;
    cacheLoaded = true;
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
    // Fall through to token cleanup below.
  }
  const noBrackets = trimmed.replace(/^\[/, "").replace(/\]$/, "");
  if (/^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(noBrackets)) {
    return noBrackets.toLowerCase();
  }
  const withoutPath = noBrackets.split(/[/?#]/)[0] ?? noBrackets;
  if (net.isIP(withoutPath)) {
    return withoutPath.toLowerCase();
  }
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

/**
 * Reset the cache. Used by tests so a fresh load picks up the new file.
 */
export function resetScopeCache(): void {
  cached = undefined;
  cacheLoaded = false;
}

function ipToNumber(ip: string): number {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return NaN;
  }
  return parts.reduce((acc, octet) => acc * 256 + octet, 0);
}

function ipInCidr(ip: string, cidr: string): boolean {
  const [base, maskRaw] = cidr.split("/");
  if (!base || !maskRaw) return false;
  const mask = Number(maskRaw);
  if (!Number.isInteger(mask) || mask < 0 || mask > 32) return false;
  const ipNum = ipToNumber(ip);
  const baseNum = ipToNumber(base);
  if (Number.isNaN(ipNum) || Number.isNaN(baseNum)) return false;
  if (mask === 0) return true;
  const shift = 32 - mask;
  // eslint-disable-next-line no-bitwise
  return (ipNum >>> shift) === (baseNum >>> shift);
}

/**
 * Returns true if `target` (hostname / IP / CIDR string) is covered by any
 * authorized entry in scope. A target is in-scope if:
 *   - it appears literally in authorizedTargets
 *   - it is a subdomain of an authorized hostname
 *   - it is an IPv4 inside an authorized CIDR
 *   - the CIDR target is exactly an authorized CIDR
 */
export function targetInScope(target: string, scope: EngagementScope): boolean {
  const trimmed = normalizeScopeTarget(target);
  if (!trimmed) return false;
  const excluded = (scope.excludedTargets ?? []).map(normalizeScopeTarget);
  if (excluded.some((entry) => matchEntry(trimmed, entry))) return false;
  return scope.authorizedTargets.some((entry) => matchEntry(trimmed, normalizeScopeTarget(entry)));
}

function matchEntry(target: string, entry: string): boolean {
  if (entry === target) return true;
  // CIDR membership for IPv4 targets
  if (entry.includes("/") && net.isIPv4(target)) {
    return ipInCidr(target, entry);
  }
  // Hostname suffix match (entry "example.com" covers "api.example.com")
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
