import { processIdentityTracker } from "../os/process-identity.js";
import { processAlive } from "../os/process-tree.js";
import { listLiveRuntimeMetadata } from "./discovery.js";
import { readRuntimeMetadata } from "./store.js";
import type { RuntimeMetadata } from "./types.js";

const DEFAULT_MAX_IDLE_RUNTIMES = 6;
const MIN_MAX_IDLE_RUNTIMES = 1;
const MAX_MAX_IDLE_RUNTIMES = 256;

export function idleRuntimeCap(): number {
  const raw = process.env.CLAI_SESSION_RUNTIME_MAX_IDLE;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_IDLE_RUNTIMES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_IDLE_RUNTIMES;
  if (parsed <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(
    MIN_MAX_IDLE_RUNTIMES,
    Math.min(MAX_MAX_IDLE_RUNTIMES, Math.floor(parsed)),
  );
}

function idleDetached(metadata: RuntimeMetadata): boolean {
  return metadata.phase === "running" && !metadata.attached && !metadata.busy;
}

export function selectEvictableRuntimes(
  runtimes: readonly RuntimeMetadata[],
  cap: number,
  exclude?: string | undefined,
): RuntimeMetadata[] {
  if (!Number.isFinite(cap)) return [];
  const idle = runtimes
    .filter(idleDetached)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  const overflow = idle.length - Math.max(0, cap);
  if (overflow <= 0) return [];
  return idle
    .filter((metadata) => metadata.sessionId !== exclude)
    .slice(0, overflow);
}

function terminableHost(metadata: RuntimeMetadata): boolean {
  const comparison = processIdentityTracker.compare(
    metadata.hostPid,
    metadata.hostIdentity,
  );
  if (comparison === "gone" || comparison === "mismatch") return false;
  return processAlive(metadata.hostPid);
}

export async function enforceIdleRuntimeCap(
  exclude?: string | undefined,
): Promise<number> {
  const cap = idleRuntimeCap();
  if (!Number.isFinite(cap)) return 0;
  const runtimes = await listLiveRuntimeMetadata().catch(() => []);
  const victims = selectEvictableRuntimes(runtimes, cap, exclude);
  let stopped = 0;
  for (const victim of victims) {
    const current = await readRuntimeMetadata(victim.sessionId).catch(() => undefined);
    if (!current || current.hostPid !== victim.hostPid || !idleDetached(current)) continue;
    if (!terminableHost(current)) continue;
    try {
      process.kill(current.hostPid, "SIGTERM");
      stopped += 1;
    } catch {
      continue;
    }
  }
  return stopped;
}
