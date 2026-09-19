import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * TASK-001: concurrent whole-plan saves used to lose transitions (a foreground
 * completion and an async responder settlement each saved their own v+1 from
 * the same base). Foreground tasks may run concurrently; no single-active
 * demotion is applied.
 */

let root: string;
let planFile: string;
let previous: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clai-plan-tx-"));
  planFile = join(root, "plans.jsonl");
  previous = process.env.CLAI_PLAN_FILE;
  process.env.CLAI_PLAN_FILE = planFile;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.CLAI_PLAN_FILE;
  else process.env.CLAI_PLAN_FILE = previous;
  await rm(root, { recursive: true, force: true });
});

async function store() {
  return await import("../src/store/plan.js");
}

async function seed(sessionId: string) {
  const { createPlan, savePlan, appendPlanTask, loadPlan } = await store();
  const plan = createPlan({
    sessionId,
    goal: "test",
    detail: "d",
    taskTitles: ["parent work", "report"],
  });
  plan.status = "in_progress";
  plan.tasks[0]!.state = "in_progress";
  appendPlanTask(plan, {
    title: "Responder · nmap",
    state: "in_progress",
    dependencies: [],
    resourceLocks: [],
    parentTaskId: plan.tasks[0]!.id,
    jobId: "job-1",
    delegationId: "deleg-1",
    responderOwned: true,
  });
  await savePlan(plan);
  return (await loadPlan(sessionId))!;
}

describe("mutatePlan", () => {
  it("keeps both writers' transitions when they interleave", async () => {
    const { mutatePlan, loadPlan } = await store();
    const seeded = await seed("s1");
    const parentId = seeded.tasks[0]!.id;
    const childId = seeded.tasks.find((t) => t.responderOwned)!.id;

    // Both reducers start from the same loaded version.
    const [foreground, settlement] = await Promise.all([
      mutatePlan("s1", (draft) => {
        const task = draft.tasks.find((t) => t.id === parentId)!;
        task.state = "done";
      }),
      mutatePlan("s1", (draft) => {
        const task = draft.tasks.find((t) => t.id === childId)!;
        task.state = "done";
        task.note = "job=job-1 status=exited exit=0";
      }),
    ]);
    expect(foreground.ok).toBe(true);
    expect(settlement.ok).toBe(true);

    const stored = (await loadPlan("s1"))!;
    expect(stored.tasks.find((t) => t.id === parentId)!.state).toBe("done");
    expect(stored.tasks.find((t) => t.id === childId)!.state).toBe("done");
    expect(stored.version).toBe((seeded.version ?? 1) + 2);
  });

  it("rejects a mutation whose expectedVersion is stale", async () => {
    const { mutatePlan } = await store();
    const seeded = await seed("s2");
    const first = await mutatePlan("s2", (draft) => {
      draft.tasks[0]!.note = "touched";
    });
    expect(first.ok).toBe(true);
    const stale = await mutatePlan(
      "s2",
      (draft) => {
        draft.tasks[0]!.note = "stale";
      },
      { expectedVersion: seeded.version ?? 1 },
    );
    expect(stale.ok).toBe(false);
    expect(stale.reason).toBe("version-conflict");
  });

  it("reports a missing plan instead of creating one", async () => {
    const { mutatePlan } = await store();
    const result = await mutatePlan("nope", (draft) => {
      draft.status = "approved";
    });
    expect(result).toMatchObject({ ok: false, reason: "missing-plan" });
  });

  it("aborts without writing when the reducer returns false", async () => {
    const { mutatePlan, loadPlan } = await store();
    const seeded = await seed("s3");
    const result = await mutatePlan("s3", () => false);
    expect(result.ok).toBe(false);
    const stored = (await loadPlan("s3"))!;
    expect(stored.version).toBe(seeded.version);
  });
});

describe("concurrent foreground tasks stay active", () => {
  it("keeps a second active foreground task on commit", async () => {
    const { mutatePlan } = await store();
    const seeded = await seed("s4");
    // Note: the responder child is inserted directly after its parent.
    const second = seeded.tasks.find((t) => t.title === "report")!.id;
    const result = await mutatePlan("s4", (draft) => {
      draft.tasks.find((t) => t.id === second)!.state = "in_progress";
    });
    expect(result.ok).toBe(true);
    const active = result.plan!.tasks.filter(
      (t) => !t.responderOwned && t.state === "in_progress",
    );
    expect(active).toHaveLength(2);
    expect(result.repairs).toBeUndefined();
  });

  it("allows a responder child to run alongside a foreground task", async () => {
    const { mutatePlan } = await store();
    await seed("s5");
    const result = await mutatePlan("s5", (draft) => {
      draft.detail = "unchanged work";
    });
    expect(result.ok).toBe(true);
    const active = result.plan!.tasks.filter((t) => t.state === "in_progress");
    expect(active).toHaveLength(2);
    expect(result.repairs).toBeUndefined();
  });
});

describe("applyForegroundSnapshot", () => {
  it("keeps settled responder children when a revision is applied", async () => {
    const { mutatePlan, loadPlan, applyForegroundSnapshot } = await store();
    const seeded = await seed("s6");
    // Settlement turns the child green.
    await mutatePlan("s6", (draft) => {
      draft.tasks.find((t) => t.responderOwned)!.state = "done";
    });
    // A revision authored from the stale snapshot (child still yellow).
    const snapshot = { ...seeded, detail: "revised detail" };
    const result = await mutatePlan("s6", (draft) => {
      applyForegroundSnapshot(draft, snapshot);
      return true;
    });
    expect(result.ok).toBe(true);
    const stored = (await loadPlan("s6"))!;
    expect(stored.detail).toBe("revised detail");
    expect(stored.tasks.find((t) => t.responderOwned)!.state).toBe("done");
  });

  it("retains a responder child created after the snapshot was authored", async () => {
    const { mutatePlan, loadPlan, applyForegroundSnapshot } = await store();
    const seeded = await seed("s7");
    const snapshot = {
      ...seeded,
      tasks: seeded.tasks.filter((t) => !t.responderOwned),
    };
    await mutatePlan("s7", (draft) => {
      applyForegroundSnapshot(draft, snapshot);
      return true;
    });
    const stored = (await loadPlan("s7"))!;
    expect(stored.tasks.some((t) => t.responderOwned)).toBe(true);
  });
});


describe("load-time concurrent foreground tasks", () => {
  it("keeps a persisted plan that has two active foreground tasks", async () => {
    const { savePlan, loadPlan } = await store();
    const seeded = await seed("s8");
    const second = seeded.tasks.find((t) => t.title === "report")!.id;
    seeded.tasks.find((t) => t.id === second)!.state = "in_progress";
    await savePlan(seeded);

    const loaded = (await loadPlan("s8"))!;
    const active = loaded.tasks.filter(
      (t) => !t.responderOwned && t.state === "in_progress",
    );
    expect(active).toHaveLength(2);
    expect(loaded.tasks.find((t) => t.id === second)!.state).toBe("in_progress");

    const reloaded = (await loadPlan("s8"))!;
    expect(reloaded.tasks.find((t) => t.id === second)!.state).toBe("in_progress");
  });
});
