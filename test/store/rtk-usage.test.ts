import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withSessionAffinity } from "../../src/llm/session-affinity.js";
import { createRtkExecutionRecorder, rtkExecutionCount } from "../../src/store/rtk-usage.js";

const originalDataDir = process.env.CLAI_DATA_DIR;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "rtk-usage-"));
  process.env.CLAI_DATA_DIR = root;
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.CLAI_DATA_DIR;
  else process.env.CLAI_DATA_DIR = originalDataDir;
  await rm(root, { recursive: true, force: true });
});

describe("RTK session execution journal", () => {
  it("counts launches once, not preparations, and isolates conversations", () => {
    const launched = createRtkExecutionRecorder("session-a");
    expect(rtkExecutionCount("session-a")).toBe(0);
    launched();
    launched();
    expect(rtkExecutionCount("session-a")).toBe(1);
    expect(rtkExecutionCount("session-b")).toBe(0);
    createRtkExecutionRecorder("session-b")();
    expect(rtkExecutionCount("session-b")).toBe(1);
    expect(rtkExecutionCount("session-a")).toBe(1);
  });

  it("captures session affinity when preparing a launch", () => {
    const launched = withSessionAffinity("session-a", () => createRtkExecutionRecorder());
    withSessionAffinity("session-b", launched);
    expect(rtkExecutionCount("session-a")).toBe(1);
    expect(rtkExecutionCount("session-b")).toBe(0);
    expect(withSessionAffinity("session-a", () => rtkExecutionCount())).toBe(1);
  });

  it("restores the same conversation's count in a fresh process", () => {
    createRtkExecutionRecorder("session-a")();
    const source = new URL("../../src/store/rtk-usage.ts", import.meta.url).href;
    const child = spawnSync(process.execPath, [
      "--import", "tsx", "--input-type=module", "--eval",
      `import {rtkExecutionCount,createRtkExecutionRecorder} from ${JSON.stringify(source)}; createRtkExecutionRecorder('session-a')(); console.log(rtkExecutionCount('session-a'));`,
    ], { encoding: "utf8", env: process.env });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe("2");
    expect(rtkExecutionCount("session-a")).toBe(2);
    expect(rtkExecutionCount("session-b")).toBe(0);
  });

  it("handles arbitrary session IDs without permitting path traversal", () => {
    createRtkExecutionRecorder("../../outside/../session")();
    expect(rtkExecutionCount("../../outside/../session")).toBe(1);
    expect(rtkExecutionCount("session")).toBe(0);
  });

  it("reports unavailable accounting on storage failure and recovers pending launches", async () => {
    const blocked = join(root, "blocked");
    await writeFile(blocked, "not a directory");
    process.env.CLAI_DATA_DIR = blocked;
    expect(() => createRtkExecutionRecorder("session-a")()).not.toThrow();
    expect(rtkExecutionCount("session-a")).toBeUndefined();
    await rm(blocked);
    await mkdir(blocked);
    createRtkExecutionRecorder("session-a")();
    expect(rtkExecutionCount("session-a")).toBe(2);
  });
});
