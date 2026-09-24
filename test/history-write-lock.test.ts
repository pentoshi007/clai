import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mirrors history-safety.test.ts: pin every data root to a temp dir so the
// real ~/.clai history is never touched.
const dataEnvKeys = [
  "CLAI_DATA_DIR",
  "CLAI_HISTORY_DIR",
  "CLAI_PLAN_DIR",
  "CLAI_LOG_DIR",
  "CLAI_ARTIFACT_DIR",
  "CLAI_JOBS_DIR",
  "CLAI_CONFIG_DIR",
] as const;

let dataDir: string;
let originalEnv: Partial<
  Record<(typeof dataEnvKeys)[number], string | undefined>
>;

beforeEach(() => {
  originalEnv = {};
  for (const key of dataEnvKeys) originalEnv[key] = process.env[key];
  dataDir = mkdtempSync(join(tmpdir(), "clai-hist-lock-"));
  process.env.CLAI_DATA_DIR = dataDir;
  process.env.CLAI_HISTORY_DIR = dataDir;
  process.env.CLAI_CONFIG_DIR = dataDir;
  process.env.CLAI_PLAN_DIR = dataDir;
  process.env.CLAI_LOG_DIR = join(dataDir, "logs");
  process.env.CLAI_ARTIFACT_DIR = join(dataDir, "artifacts");
  process.env.CLAI_JOBS_DIR = join(dataDir, "jobs");
  mkdirSync(join(dataDir, "logs"), { recursive: true });
  vi.resetModules();
});

afterEach(async () => {
  for (const key of dataEnvKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  vi.resetModules();
});

function deadPid(): number {
  for (let pid = 4_000_000; pid < 4_100_000; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (error: any) {
      if (error?.code === "ESRCH") return pid;
    }
  }
  throw new Error("no unused pid available for test");
}

describe("jsonl write lock", () => {
  it("reaps a fresh lock file left behind by a dead process", async () => {
    const { acquireJsonlWriteLock } = await import(
      "../src/store/history/jsonl-lock.js"
    );
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, "history.jsonl.lock"),
      `${deadPid()}-${Date.now()}-deadbeef`,
    );

    const release = await acquireJsonlWriteLock();
    await release();
  });

  it("does not reap a lock held by a live process", async () => {
    const { acquireJsonlWriteLock } = await import(
      "../src/store/history/jsonl-lock.js"
    );
    const first = await acquireJsonlWriteLock();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, "history.jsonl.lock.reaper"),
      `${process.pid}-${Date.now()}-live`,
    );

    await expect(acquireJsonlWriteLock()).rejects.toThrow(
      "timed out waiting for history write lock",
    );
    await first();
  }, 60_000);
});

describe("queued history writes", () => {
  it("falls back instead of rejecting when the write lock stays held", async () => {
    const { acquireJsonlWriteLock } = await import(
      "../src/store/history/jsonl-lock.js"
    );
    const first = await acquireJsonlWriteLock();
    const { queueJsonlWrite } = await import(
      "../src/store/history/jsonl-backend.js"
    );

    const outcome = await queueJsonlWrite(
      async () => "written",
      () => "fallback",
    );
    expect(outcome).toBe("fallback");
    await first();
  }, 60_000);
});

describe("clearAllHistory", () => {
  it("reports the lock failure instead of throwing when the lock stays held", async () => {
    const { acquireJsonlWriteLock } = await import(
      "../src/store/history/jsonl-lock.js"
    );
    const first = await acquireJsonlWriteLock();
    const { clearAllHistory } = await import(
      "../src/store/history/lifecycle.js"
    );

    const result = await clearAllHistory();
    expect(result.cleared).toBe(true);
    expect(result.detail).toContain("timed out waiting for history write lock");
    await first();
  }, 60_000);
});
