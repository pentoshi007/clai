import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const originalWorker = process.env.VITEST_WORKER_ID;
const originalPlanFile = process.env.CLAI_PLAN_FILE;
const originalPlanDir = process.env.CLAI_PLAN_DIR;
let sandbox: string | undefined;

afterEach(async () => {
  if (originalWorker === undefined) delete process.env.VITEST_WORKER_ID;
  else process.env.VITEST_WORKER_ID = originalWorker;
  if (originalPlanFile === undefined) delete process.env.CLAI_PLAN_FILE;
  else process.env.CLAI_PLAN_FILE = originalPlanFile;
  if (originalPlanDir === undefined) delete process.env.CLAI_PLAN_DIR;
  else process.env.CLAI_PLAN_DIR = originalPlanDir;
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
  sandbox = undefined;
  vi.resetModules();
});

describe("SQLite plan backend failures", () => {
  it("propagates initialization errors instead of falling back to JSONL", async () => {
    sandbox = await mkdtemp(join(tmpdir(), "clai-sqlite-failure-"));
    const blockedDirectory = join(sandbox, "not-a-directory");
    await writeFile(blockedDirectory, "blocked");
    delete process.env.VITEST_WORKER_ID;
    delete process.env.CLAI_PLAN_FILE;
    process.env.CLAI_PLAN_DIR = blockedDirectory;
    vi.resetModules();

    const { loadDatabase } = await import(
      "../../src/store/plan/sqlite-backend.js"
    );
    await expect(loadDatabase()).rejects.toBeInstanceOf(Error);
  });
});
