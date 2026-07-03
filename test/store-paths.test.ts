import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const envKeys = [
  "CLAI_CONFIG_DIR",
  "CLAI_DATA_DIR",
  "CLAI_HISTORY_DIR",
  "CLAI_PLAN_DIR",
  "CLAI_LOG_DIR",
  "CLAI_ARTIFACT_DIR",
  "CLAI_JOBS_DIR",
] as const;

type EnvKey = (typeof envKeys)[number];

let root: string;
let previousEnv: Partial<Record<EnvKey, string | undefined>>;

beforeEach(() => {
  previousEnv = {};
  for (const key of envKeys) previousEnv[key] = process.env[key];
  root = mkdtempSync(join(tmpdir(), "clai-store-paths-"));
  process.env.CLAI_CONFIG_DIR = join(root, "config");
  process.env.CLAI_DATA_DIR = join(root, "data");
  process.env.CLAI_HISTORY_DIR = join(root, "history");
  process.env.CLAI_PLAN_DIR = join(root, "plans");
  process.env.CLAI_LOG_DIR = join(root, "logs");
  process.env.CLAI_ARTIFACT_DIR = join(root, "artifacts");
  process.env.CLAI_JOBS_DIR = join(root, "jobs");
  vi.resetModules();
});

afterEach(async () => {
  for (const key of envKeys) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
  vi.resetModules();
});

describe("store path roots", () => {
  it("routes history and plan storage through injected roots", async () => {
    const history = await import("../src/store/history.js");
    const plan = await import("../src/store/plan.js");

    expect(history.getJsonlHistoryPath()).toBe(join(root, "history", "history.jsonl"));

    await history.saveSession([{ role: "user", content: "hello" }]);
    expect(existsSync(join(root, "history", "history.jsonl"))).toBe(true);

    const sessionPlan = plan.createPlan({
      sessionId: "session-1",
      goal: "test",
      detail: "detail",
      taskTitles: ["one"],
    });
    await plan.savePlan(sessionPlan);

    expect(existsSync(join(root, "plans", "plans.jsonl"))).toBe(true);
  });

  it("routes logs and cleanup artifacts through injected roots", async () => {
    const { auditLog, clearArtifacts, getLogsDir } = await import("../src/store/logs.js");
    const artifact = join(root, "artifacts", "out.txt");

    mkdirSync(join(root, "artifacts"), { recursive: true });
    writeFileSync(artifact, "raw output", { flag: "w" });
    await auditLog("test.event", { ok: true });

    expect(getLogsDir()).toBe(join(root, "logs"));
    expect(existsSync(join(root, "logs"))).toBe(true);
    expect((await clearArtifacts()).removed).toBe(1);
    expect(existsSync(artifact)).toBe(false);
  });

  it("routes shell artifacts through the injected artifact root", async () => {
    const { shellExec } = await import("../src/tools/shell.js");

    const result = await shellExec({
      command: "printf shell-path-test",
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(true);
    expect(result.outputPath).toMatch(join(root, "artifacts"));
  });

  it("routes background job artifacts through the injected jobs root", async () => {
    const { JobManager } = await import("../src/tools/jobs.js");
    const manager = new JobManager();

    const result = await manager.startJob("printf job-path-test");

    expect(result.ok).toBe(true);
    expect(result.output).toContain(join(root, "jobs"));
  });
});
