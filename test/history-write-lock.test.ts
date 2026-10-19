import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
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

async function inFakeTime<T>(work: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    let settled = false;
    const result = work().finally(() => { settled = true; });
    result.catch(() => undefined);
    while (!settled) {
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(250);
    }
    return await result;
  } finally {
    vi.useRealTimers();
  }
}

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

    await expect(inFakeTime(() => acquireJsonlWriteLock())).rejects.toThrow(
      "timed out waiting for history write lock",
    );
    await first();
  });
});

describe("jsonl write lock ownership evidence", () => {
  const age = (path: string, ms: number) => {
    const at = new Date(Date.now() - ms);
    utimesSync(path, at, at);
  };

  it("reaps a lock whose live pid now belongs to a different process", async () => {
    const { acquireJsonlWriteLock } = await import("../src/store/history/jsonl-lock.js");
    mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, "history.jsonl.lock");
    writeFileSync(path, `${process.ppid}-${Date.now()}-recycled-${"0".repeat(64)}`);
    age(path, 10_000);
    const release = await acquireJsonlWriteLock();
    await release();
  });

  it("keeps a heartbeating lock owned by a living writer", async () => {
    const { acquireStorageWriteLock } = await import("../src/store/history/jsonl-lock.js");
    const path = join(dataDir, "heartbeat.lock");
    const held = await acquireStorageWriteLock(path, "prompt journal");
    try {
      const token = readFileSync(path, "utf8");
      age(path, 60_000);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(Date.now() - statSync(path).mtimeMs).toBeLessThan(5_000);
      expect(readFileSync(path, "utf8")).toBe(token);
    } finally {
      await held();
    }
    expect(existsSync(path)).toBe(false);
  });

  it("reaps an abandoned lock whose token was never written", async () => {
    const { acquireJsonlWriteLock } = await import("../src/store/history/jsonl-lock.js");
    mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, "history.jsonl.lock");
    writeFileSync(path, "");
    age(path, 60_000);
    const release = await acquireJsonlWriteLock();
    await release();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reaps an unreadable lock left by another account once its heartbeat is stale",
    async () => {
      const { acquireJsonlWriteLock } = await import("../src/store/history/jsonl-lock.js");
      mkdirSync(dataDir, { recursive: true });
      const path = join(dataDir, "history.jsonl.lock");
      writeFileSync(path, `${process.pid}-${Date.now()}-other-account`);
      chmodSync(path, 0o000);
      age(path, 60_000);
      const release = await acquireJsonlWriteLock();
      await release();
    },
  );

  it("names the contended store in its timeout", async () => {
    const { acquireStorageWriteLock } = await import("../src/store/history/jsonl-lock.js");
    const held = await acquireStorageWriteLock(join(dataDir, "journal.lock"), "prompt journal");
    try {
      await expect(inFakeTime(() => acquireStorageWriteLock(join(dataDir, "journal.lock"), "prompt journal")))
        .rejects.toThrow("timed out waiting for prompt journal write lock");
    } finally {
      await held();
    }
  });
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

    const outcome = await inFakeTime(() => queueJsonlWrite(
      async () => "written",
      () => "fallback",
    ));
    expect(outcome).toBe("fallback");
    await first();
  });
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

    const result = await inFakeTime(() => clearAllHistory());
    expect(result.cleared).toBe(true);
    expect(result.detail).toContain("timed out waiting for history write lock");
    await first();
  });
});
