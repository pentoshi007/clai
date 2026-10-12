import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "clai-lock-recovery-"));
  vi.stubEnv("CLAI_HISTORY_DIR", directory);
  vi.resetModules();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
  vi.resetModules();
});

function deadToken(): string {
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  expect(child.status).toBe(0);
  return `${child.pid}-${Date.now()}-exited`;
}

async function acquireAndRelease(): Promise<void> {
  const { acquireJsonlWriteLock } = await import("../src/store/history/jsonl-lock.js");
  const release = await acquireJsonlWriteLock();
  await release();
  await expect(readFile(join(directory, "history.jsonl.lock"))).rejects.toMatchObject({ code: "ENOENT" });
}

describe("history lock crash recovery", () => {
  it("recovers a fresh dead holder even when its reaper also died", async () => {
    const token = deadToken();
    await writeFile(join(directory, "history.jsonl.lock"), token);
    await writeFile(join(directory, "history.jsonl.lock.reaper"), token);
    await acquireAndRelease();
    await expect(readFile(join(directory, "history.jsonl.lock.reaper"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 25_000);

  it.each(["", "incomplete-token"])("recovers an interrupted lock initialization: %j", async (token) => {
    const path = join(directory, "history.jsonl.lock");
    await writeFile(path, token);
    const interrupted = new Date(Date.now() - 2_000);
    await utimes(path, interrupted, interrupted);
    await acquireAndRelease();
  }, 25_000);

  it("recovers an interrupted reaper initialization", async () => {
    await writeFile(join(directory, "history.jsonl.lock"), deadToken());
    const path = join(directory, "history.jsonl.lock.reaper");
    await writeFile(path, "");
    const interrupted = new Date(Date.now() - 2_000);
    await utimes(path, interrupted, interrupted);
    await acquireAndRelease();
  }, 25_000);
});

describe("history lock ownership", () => {
  it("does not steal a writer while its token is being initialized", async () => {
    const path = join(directory, "history.jsonl.lock");
    await writeFile(path, "");
    const { acquireJsonlWriteLock } = await import("../src/store/history/jsonl-lock.js");
    const pending = acquireJsonlWriteLock();
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    expect(await readFile(path, "utf8")).toBe("");
    await writeFile(path, `${process.pid}-${Date.now()}-initializing`);
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    expect(await readFile(path, "utf8")).toContain("-initializing");
    await rm(path);
    const release = await pending;
    await release();
  });

  it("preserves a live holder beyond the initialization grace period", async () => {
    const { acquireJsonlWriteLock } = await import("../src/store/history/jsonl-lock.js");
    const first = await acquireJsonlWriteLock();
    const path = join(directory, "history.jsonl.lock");
    const token = await readFile(path, "utf8");
    const active = new Date(Date.now() - 10_000);
    await utimes(path, active, active);
    const pending = acquireJsonlWriteLock();
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    expect(await readFile(path, "utf8")).toBe(token);
    await first();
    const release = await pending;
    await release();
  });
});
