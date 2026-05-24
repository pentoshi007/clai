import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import net from "node:net";

const scopeFile = join(homedir(), ".clai", "scope.json");

export interface EngagementScope {
  name?: string | undefined;
  authorizedTargets: string[];
  excludedTargets?: string[] | undefined;
  allowedPhases?: Array<"recon" | "enumeration" | "exploitation" | "post-exploitation"> | undefined;
  maxRate?: number | undefined;
  maxConcurrency?: number | undefined;
  authorizationNote?: string | undefined;
  createdAt?: string | undefined;
  expiresAt?: string | undefined;
}

let cached: EngagementScope | undefined;
let cacheLoaded = false;

export async function loadScope(): Promise<EngagementScope | undefined> {
  if (cacheLoaded) return cached;
  cacheLoaded = true;
  if (!existsSync(scopeFile)) return undefined;
  try {
    const raw = await readFile(scopeFile, "utf8");
    cached = JSON.parse(raw) as EngagementScope;
    return cached;
  } catch {
    return undefined;
  }
}

export async function saveScope(scope: EngagementScope): Promise<void> {
  await mkdir(join(homedir(), ".clai"), { recursive: true });
  await writeFile(scopeFile, `${JSON.stringify(scope, null, 2)}\n`, { mode: 0o600 });
  cached = scope;
  cacheLoaded = true;
}

export async function clearScope(): Promise<void> {
  cached = undefined;
  cacheLoaded = true;
  if (existsSync(scopeFile)) {
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
  const trimmed = target.trim().toLowerCase();
  if (!trimmed) return false;
  const excluded = (scope.excludedTargets ?? []).map((t) => t.toLowerCase());
  if (excluded.some((entry) => matchEntry(trimmed, entry))) return false;
  return scope.authorizedTargets.some((entry) => matchEntry(trimmed, entry.toLowerCase()));
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
