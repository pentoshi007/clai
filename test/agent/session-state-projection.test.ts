import { describe, expect, it } from "vitest";
import type { BackgroundJob } from "../../src/tools/jobs.js";
import type { PlanTask, SessionPlan } from "../../src/store/plan.js";
import { inferNextHint } from "../../src/agent/session-state.js";
import { buildTurnSessionStateSnapshot } from "../../src/agent/turn/session-state-projection.js";

const task = (
  id: string,
  state: PlanTask["state"],
  overrides: Partial<PlanTask> = {},
): PlanTask => ({ id, title: `task ${id}`, state, ...overrides }) as PlanTask;

const plan = (tasks: PlanTask[]): SessionPlan =>
  ({
    sessionId: "session-1",
    goal: "ship it",
    detail: "",
    tasks,
    status: "active",
    kind: "coding",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }) as SessionPlan;

const job = (id: string, command: string, display = ""): BackgroundJob =>
  ({
    id,
    status: "running",
    command,
    commandDisplay: display,
  }) as unknown as BackgroundJob;

const base = {
  prompt: "x".repeat(300),
  projectRoot: "/workspace",
  packageManager: "npm",
  runningJobs: [] as readonly BackgroundJob[],
  featureAppRequired: false,
  featureSeen: false,
  scaffoldOk: false,
  serverStarted: false,
  serverProbedOk: false,
  lastProbeFailed: false,
  lastOkTool: undefined,
  pentestSession: false,
};

describe("session state projection", () => {
  it("falls back to a truncated prompt goal when no plan exists", () => {
    const snapshot = buildTurnSessionStateSnapshot({ ...base, plan: undefined });
    expect(snapshot.goal).toHaveLength(160);
    expect(snapshot.planStatus).toBeUndefined();
    expect(snapshot.pendingTasks).toBeUndefined();
  });

  it("partitions plan tasks and excludes responder-owned foreground work", () => {
    const snapshot = buildTurnSessionStateSnapshot({
      ...base,
      plan: plan([
        task("t1", "in_progress", { responderOwned: true }),
        task("t2", "in_progress"),
        task("t3", "pending"),
        task("t4", "pending", { responderOwned: true }),
        task("t5", "done"),
        task("t6", "skipped"),
      ]),
    });

    expect(snapshot.goal).toBe("ship it");
    expect(snapshot.openTask).toBe("[t2] task t2");
    expect(snapshot.pendingTasks).toEqual(["[t3] task t3"]);
    expect(snapshot.doneTasks).toEqual(["t5", "t6"]);
  });

  it("summarizes at most four running jobs and prefers the display command", () => {
    const snapshot = buildTurnSessionStateSnapshot({
      ...base,
      plan: undefined,
      runningJobs: [
        job("j1", "raw one", "display   one"),
        job("j2", "raw two"),
        job("j3", "raw three"),
        job("j4", "raw four"),
        job("j5", "raw five"),
      ],
    });

    expect(snapshot.backgroundJobs).toBe(
      "5 running: j1 running display one; j2 running raw two; j3 running raw three; j4 running raw four",
    );
  });

  it("adds the engagement note only for a pentest session and always sets a hint", () => {
    const plain = buildTurnSessionStateSnapshot({ ...base, plan: undefined });
    expect(plain.engagementNote).toBeUndefined();
    expect(plain.nextHint).toBe(inferNextHint({ ...plain, nextHint: undefined }));

    const engagement = buildTurnSessionStateSnapshot({
      ...base,
      plan: undefined,
      pentestSession: true,
    });
    expect(engagement.engagementNote).toBe(
      "remote/security engagement — no local dev server as completion",
    );
  });
});
