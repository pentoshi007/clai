import { appendFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const jsonlPath = join(tmpdir(), `clai-plans-resilience-${process.pid}.jsonl`);
const previousPlanFile = process.env.CLAI_PLAN_FILE;
process.env.CLAI_PLAN_FILE = jsonlPath;
vi.resetModules();
const { clearAllPlans, createPlan, deletePlan, loadPlan, savePlan } = await import(
  "../src/store/plan.js"
);

afterAll(() => {
  if (previousPlanFile === undefined) delete process.env.CLAI_PLAN_FILE;
  else process.env.CLAI_PLAN_FILE = previousPlanFile;
});

function planFor(sessionId: string, goal: string) {
  return createPlan({
    sessionId,
    goal,
    detail: "detail",
    taskTitles: ["one", "two"],
    kind: "general",
  });
}

describe("plan jsonl resilience", () => {
  beforeEach(async () => {
    await clearAllPlans();
  });

  it("a corrupt line does not wipe other plans on save", async () => {
    await savePlan(planFor("s1", "first"));
    await savePlan(planFor("s2", "second"));
    await appendFile(jsonlPath, '{"sessionId":"broken","goal":');
    await savePlan(planFor("s3", "third"));
    expect((await loadPlan("s1"))?.goal).toBe("first");
    expect((await loadPlan("s2"))?.goal).toBe("second");
    expect((await loadPlan("s3"))?.goal).toBe("third");
  });

  it("loadPlan skips corrupt lines and still finds valid plans", async () => {
    await savePlan(planFor("s1", "first"));
    await appendFile(jsonlPath, "not json at all\n");
    expect((await loadPlan("s1"))?.goal).toBe("first");
  });

  it("writes leave a valid jsonl file with no temp leftovers", async () => {
    await savePlan(planFor("s1", "first"));
    await savePlan(planFor("s2", "second"));
    const raw = await readFile(jsonlPath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const leftovers = (await readdir(tmpdir())).filter((name) =>
      name.startsWith(`${basename(jsonlPath)}.`),
    );
    expect(leftovers).toEqual([]);
  });

  it("deletePlan removes only the target plan", async () => {
    await savePlan(planFor("s1", "first"));
    await savePlan(planFor("s2", "second"));
    await deletePlan("s1");
    expect(await loadPlan("s1")).toBeUndefined();
    expect((await loadPlan("s2"))?.goal).toBe("second");
  });
});
