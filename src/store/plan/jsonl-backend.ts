import { fixOwner, handlePermissionError, safeExists } from "../../os/permissions.js";
import { planDir, SessionPlan } from "./sqlite-backend.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const jsonlFile =
  process.env.CLAI_PLAN_FILE ??
  (process.env.CLAI_PLAN_DIR || process.env.CLAI_DATA_DIR
    ? join(planDir, "plans.jsonl")
    : process.env.VITEST_WORKER_ID
    ? join(tmpdir(), `clai-plans-${process.env.VITEST_WORKER_ID}.jsonl`)
    : join(planDir, "plans.jsonl"));

/**
 * Every plan write is serialized in-process.
 *
 * The JSONL backend rewrites the whole file (read → modify → write) and the
 * SQLite backend used an unconditional UPSERT, so two concurrent writers (a
 * foreground task transition and an asynchronous responder settlement) could
 * each save their own `v+1` derived from the same base version. The later write
 * silently reverted the earlier one — reopening completed parents or re-yellowing
 * settled children.
 */
let planWriteQueue: Promise<unknown> = Promise.resolve();

let planWriteDepth = 0;

export function enqueuePlanWrite<T>(task: () => Promise<T>): Promise<T> {
  // Re-entrancy: a queued mutation may load a plan that heals itself through
  // savePlan. Waiting on the queue from inside the queue would deadlock.
  if (planWriteDepth > 0) return task();
  const tracked = async (): Promise<T> => {
    planWriteDepth += 1;
    try {
      return await task();
    } finally {
      planWriteDepth -= 1;
    }
  };
  const run = planWriteQueue.then(tracked, tracked);
  // Keep the chain alive regardless of individual failures.
  planWriteQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const jsonlLockDir = `${jsonlFile}.lock`;

const JSONL_LOCK_STALE_MS = 10_000;

/** Cross-process advisory lock for the JSONL fallback (atomic mkdir). */
export async function withJsonlLock<T>(task: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 5_000;
  try {
    await mkdir(dirname(jsonlFile), { recursive: true });
  } catch {
    // Directory creation is retried by appendJsonl.
  }
  for (;;) {
    try {
      await mkdir(jsonlLockDir);
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      // Break a stale lock left behind by a crashed process.
      try {
        const info = await stat(jsonlLockDir);
        if (Date.now() - info.mtimeMs > JSONL_LOCK_STALE_MS) {
          await rm(jsonlLockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring plan store lock: ${jsonlLockDir}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  try {
    return await task();
  } finally {
    await rm(jsonlLockDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

export async function writeJsonlAtomic(plans: readonly SessionPlan[]): Promise<void> {
  await mkdir(planDir, { recursive: true });
  await fixOwner(planDir);
  const body = plans.map((p) => JSON.stringify(p)).join("\n");
  const tmp = `${jsonlFile}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tmp, body ? `${body}\n` : "", { mode: 0o600 });
  await rename(tmp, jsonlFile);
  await fixOwner(jsonlFile);
}

export async function appendJsonl(plan: SessionPlan): Promise<void> {
  try {
    const existing = await readAllJsonl();
    const map = new Map(existing.map((p) => [p.sessionId, p]));
    map.set(plan.sessionId, plan);
    await writeJsonlAtomic([...map.values()]);
  } catch (err: any) {
    handlePermissionError(err);
  }
}

export async function readAllJsonl(): Promise<SessionPlan[]> {
  if (!(await safeExists(jsonlFile))) return [];
  try {
    const raw = await readFile(jsonlFile, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as SessionPlan];
        } catch {
          return [];
        }
      });
  } catch (err: any) {
    if (err && err.code === "EACCES") {
      handlePermissionError(err);
    }
    return [];
  }
}
