import { describe, expect, it, vi } from "vitest";
import type { PlanTask, SessionPlan } from "../../src/store/plan.js";
import {
  ledgerFromTaskEvidence,
  openTaskLedger,
  type LooseWorkReceipt,
  type TaskWorkLedger,
} from "../../src/agent/task-evidence.js";
import {
  evaluateTaskCompletionGate,
  planHasVerifiedRemoteWork,
  planHasVerifiedRuntime,
  resolveLedgerForTaskGate,
  type TaskGatePorts,
} from "../../src/agent/turn/task-gate.js";

const plan = (tasks: PlanTask[], kind = "coding"): SessionPlan =>
  ({
    sessionId: "session-1",
    goal: "goal",
    detail: "",
    tasks,
    status: "active",
    kind,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }) as SessionPlan;

const task = (id: string, overrides: Partial<PlanTask> = {}): PlanTask =>
  ({ id, title: `task ${id}`, state: "in_progress", ...overrides }) as PlanTask;

const ports = (overrides: Partial<TaskGatePorts> = {}): TaskGatePorts => ({
  getLiveLedger: () => null,
  setLiveLedger: () => undefined,
  getLooseWork: () => [],
  featureAppRequired: false,
  existingProject: () => false,
  ...overrides,
});

describe("plan evidence predicates", () => {
  it("detects runtime and remote proof from any task", () => {
    expect(
      planHasVerifiedRuntime(
        plan([task("t1"), task("t2", { evidence: { sawLocalHttpProbeOk: true } as never })]),
      ),
    ).toBe(true);
    expect(planHasVerifiedRuntime(plan([task("t1")]))).toBe(false);
    expect(
      planHasVerifiedRemoteWork(
        plan([task("t1", { evidence: { sawRemoteActiveTestOk: true } as never })]),
      ),
    ).toBe(true);
  });
});

describe("task gate ledger resolution", () => {
  it("prefers the live ledger only when it is at least as advanced", () => {
    const durableTask = task("t1", {
      evidence: { successWorkCount: 3, lastOkTool: "fs.write" } as never,
    });
    const behind: TaskWorkLedger = { ...openTaskLedger("t1"), successWorkCount: 1 };
    const resolvedFromDurable = resolveLedgerForTaskGate(
      ports({ getLiveLedger: () => behind }),
      plan([durableTask]),
      "t1",
    );
    expect(resolvedFromDurable?.successWorkCount).toBe(
      ledgerFromTaskEvidence("t1", durableTask.evidence).successWorkCount,
    );

    const ahead: TaskWorkLedger = { ...openTaskLedger("t1"), successWorkCount: 9 };
    expect(
      resolveLedgerForTaskGate(
        ports({ getLiveLedger: () => ahead }),
        plan([durableTask]),
        "t1",
      )?.successWorkCount,
    ).toBe(9);
  });

  it("absorbs loose work and adopts the advanced ledger once", () => {
    const setLiveLedger = vi.fn();
    const loose: LooseWorkReceipt[] = [
      { tool: "shell.exec", summary: "ran tests", ok: true } as never,
    ];
    const resolved = resolveLedgerForTaskGate(
      ports({ getLooseWork: () => loose, setLiveLedger }),
      plan([task("t1")]),
      "t1",
    );

    expect(resolved?.successWorkCount).toBeGreaterThan(0);
    expect(setLiveLedger).toHaveBeenCalledTimes(1);
    expect(setLiveLedger.mock.calls[0]![0]).toBe(resolved);
  });

  it("does not adopt a ledger with no successful work", () => {
    const setLiveLedger = vi.fn();
    resolveLedgerForTaskGate(ports({ setLiveLedger }), plan([task("t1")]), "t1");
    expect(setLiveLedger).not.toHaveBeenCalled();
  });
});

describe("task completion gate", () => {
  it("blocks completion without evidence and reports a reason", () => {
    const gate = evaluateTaskCompletionGate(ports(), plan([task("t1")]), "t1");
    expect(gate.ok).toBe(false);
    expect(typeof gate.reason === "string" || gate.reason === undefined).toBe(true);
  });

  it("passes the feature and project context into the gate", () => {
    const existingProject = vi.fn(() => true);
    evaluateTaskCompletionGate(
      ports({ featureAppRequired: true, existingProject }),
      plan([task("t1")]),
      "t1",
    );
    expect(existingProject).toHaveBeenCalledTimes(1);
  });
});
