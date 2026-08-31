import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function processAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const PROCESS_IDENTITY_TTL_MS = 15_000;

const PROCESS_IDENTITY_CACHE_MAX = 512;

const processIdentityCache = new Map<
  number,
  { value: string | undefined; at: number }
>();

function readLinuxProcessStart(pid: number): string | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commEnd = raw.lastIndexOf(")");
    if (commEnd < 0) return undefined;
    const fields = raw.slice(commEnd + 2).trim().split(/\s+/);
    const startTime = fields[19];
    return startTime && startTime.length > 0 ? startTime : undefined;
  } catch {
    return undefined;
  }
}

function readPsProcessStart(pid: number): string | undefined {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function computeProcessIdentity(pid: number): string | undefined {
  const raw =
    process.platform === "linux"
      ? readLinuxProcessStart(pid)
      : readPsProcessStart(pid);
  return raw ? createHash("sha256").update(raw).digest("hex") : undefined;
}

function pruneProcessIdentityCache(now: number): void {
  if (processIdentityCache.size <= PROCESS_IDENTITY_CACHE_MAX) return;
  for (const [pid, entry] of processIdentityCache) {
    if (now - entry.at >= PROCESS_IDENTITY_TTL_MS) processIdentityCache.delete(pid);
  }
  if (processIdentityCache.size > PROCESS_IDENTITY_CACHE_MAX) {
    processIdentityCache.clear();
  }
}

export function forgetProcessIdentity(pid: number | undefined): void {
  if (pid) processIdentityCache.delete(pid);
}

export function processIdentity(
  pid: number | undefined,
  options: { refresh?: boolean } = {},
): string | undefined {
  if (!pid || process.platform === "win32") return undefined;
  const now = Date.now();
  const cached = processIdentityCache.get(pid);
  if (
    cached &&
    !options.refresh &&
    now - cached.at < PROCESS_IDENTITY_TTL_MS
  ) {
    return cached.value;
  }
  const value = computeProcessIdentity(pid);
  processIdentityCache.set(pid, { value, at: now });
  pruneProcessIdentityCache(now);
  return value;
}
