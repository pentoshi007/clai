import { describe, expect, it } from "vitest";
import type { PlanTask, SessionPlan } from "../../src/store/plan.js";
import type { ToolCall } from "../../src/types.js";
import type { TaskWorkLedger } from "../../src/agent/task-evidence.js";
import {
  autostartPlanTask,
  selectAutostartTask,
  type TaskAutostartPorts,
} from "../../src/agent/turn/task-autostart.js";

const task = (overrides: Partial<PlanTask>): PlanTask =>
  ({
    id: "t1",
    title: "implement the endpoint",
    state: "pending",
    dependencies: [],
    resourceLocks: [],
    ...overrides,
  }) as PlanTask;

const plan = (
  tasks: PlanTask[],
  overrides: Partial<SessionPlan> = {},
): SessionPlan =>
  ({
    sessionId: "s1",
    goal: "goal",
    kind: "build",
    status: "approved",
    tasks,
    ...overrides,
  }) as SessionPlan;

const call: ToolCall = { name: "fs.write", args: { path: "src/app.ts" } };

const recording = () => {
  const events: string[] = [];
  let ledger: TaskWorkLedger | null = null;
  const ports: TaskAutostartPorts = {
    openTask: async (taskId) => {
      events.push(`open:${taskId}`);
    },
    renderPlan: () => events.push("render"),
    notify: (message) => events.push(`notify:${message}`),
    getLedger: () => ledger,
    setLedger: (next) => {
      ledger = next;
      events.push(`ledger:${next?.taskId ?? "none"}`);
    },
  };
  return {
    events,
    ports,
    ledger: () => ledger,
  };
};

describe("task autostart", () => {
  it("picks a ready pending task when nothing is in progress", () => {
    const selected = selectAutostartTask(plan([task({})]), call);
    expect(selected?.id).toBe("t1");
  });

  it("does nothing when a foreground task is already open", () => {
    expect(
      selectAutostartTask(plan([task({ state: "in_progress" })]), call),
    ).toBeUndefined();
  });

  it("ignores responder-owned tasks when deciding", () => {
    expect(
      selectAutostartTask(
        plan([task({ state: "in_progress", responderOwned: true })]),
        call,
      ),
    ).toBeUndefined();
  });

  it("does nothing when every task is settled", () => {
    expect(
      selectAutostartTask(plan([task({ state: "done" })]), call),
    ).toBeUndefined();
  });

  it("skips the gate for preflight tools", () => {
    expect(
      selectAutostartTask(plan([task({})]), { name: "tool.check", args: {} }),
    ).toBeUndefined();
  });

  it("skips the gate for read-only recon on a pentest plan", () => {
    const reconCall: ToolCall = { name: "dns.lookup", args: { host: "x" } };
    expect(
      selectAutostartTask(plan([task({})], { kind: "pentest" }), reconCall),
    ).toBeUndefined();
    expect(
      selectAutostartTask(plan([task({})], { kind: "build" }), reconCall)?.id,
    ).toBe("t1");
  });

  it("opens the task, seeds the ledger, renders, then notifies", async () => {
    const harness = recording();
    const live = plan([task({})], { status: "approved" });
    await autostartPlanTask(live, call, harness.ports);
    expect(live.tasks[0]!.state).toBe("in_progress");
    expect(live.status).toBe("in_progress");
    expect(harness.events).toEqual([
      "open:t1",
      "ledger:t1",
      "render",
      "notify:auto-started [t1] so work can continue",
    ]);
  });

  it("keeps an existing ledger for the same task", async () => {
    const harness = recording();
    harness.ports.setLedger({
      taskId: "t1",
      successWorkCount: 3,
    } as TaskWorkLedger);
    harness.events.length = 0;
    await autostartPlanTask(plan([task({})]), call, harness.ports);
    expect(harness.events).toEqual([
      "open:t1",
      "render",
      "notify:auto-started [t1] so work can continue",
    ]);
    expect(harness.ledger()?.successWorkCount).toBe(3);
  });

  it("emits nothing when no task is selected", async () => {
    const harness = recording();
    await autostartPlanTask(
      plan([task({ state: "in_progress" })]),
      call,
      harness.ports,
    );
    expect(harness.events).toEqual([]);
  });
});
