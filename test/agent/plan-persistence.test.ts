import { describe, expect, it } from "vitest";
import type { SessionPlan } from "../../src/store/plan.js";
import {
  persistProjectRootOnPlan,
  persistTaskEvidence,
  type PlanMutator,
} from "../../src/agent/turn/plan-persistence.js";

const plan = (): SessionPlan => ({
  sessionId: "session",
  goal: "goal",
  detail: "detail",
  kind: "bugfix",
  status: "in_progress",
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  tasks: [
    {
      id: "t1",
      title: "task",
      state: "in_progress",
      dependencies: [],
      resourceLocks: [],
    },
  ],
});

const committingMutator = (draft: SessionPlan): PlanMutator => async (reducer) => {
  reducer(draft);
  draft.version = (draft.version ?? 1) + 1;
  return { ok: true, plan: structuredClone(draft) };
};

describe("plan persistence projections", () => {
  it("returns the committed project-root snapshot", async () => {
    const draft = plan();
    const committed = await persistProjectRootOnPlan(
      committingMutator(draft),
      "/tmp/project",
    );

    expect(committed?.version).toBe(2);
    expect(committed?.meta?.projectRoot).toBe("/tmp/project");
  });

  it("treats only a confirmed missing plan as optional root metadata", async () => {
    const missing: PlanMutator = async () => ({
      ok: false,
      reason: "missing-plan",
    });
    const failed: PlanMutator = async () => ({
      ok: false,
      reason: "persist-failed",
    });

    await expect(
      persistProjectRootOnPlan(missing, "/tmp/project"),
    ).resolves.toBeUndefined();
    await expect(
      persistProjectRootOnPlan(failed, "/tmp/project"),
    ).rejects.toThrow("persist-failed");
  });

  it("returns committed evidence and rejects failed persistence", async () => {
    const draft = plan();
    const evidence = { successWorkCount: 3, lastOkTool: "fs.edit" };
    const committed = await persistTaskEvidence(
      committingMutator(draft),
      "t1",
      evidence,
    );

    expect(committed.version).toBe(2);
    expect(committed.tasks[0]?.evidence).toEqual(evidence);

    const failed: PlanMutator = async () => ({
      ok: false,
      reason: "persist-failed",
    });
    await expect(persistTaskEvidence(failed, "t1", evidence)).rejects.toThrow(
      "persist-failed",
    );
  });
});
