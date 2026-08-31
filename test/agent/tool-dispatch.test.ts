import { describe, expect, it } from "vitest";
import type { PlanTask, SessionPlan } from "../../src/store/plan.js";
import type { ToolCall } from "../../src/types.js";
import type { TaskWorkLedger } from "../../src/agent/task-evidence.js";
import {
  resolveToolDispatch,
  type ToolDispatchPorts,
} from "../../src/agent/turn/tool-execution/dispatch.js";

const task = (overrides: Partial<PlanTask>): PlanTask =>
  ({
    id: "t1",
    title: "run the scan",
    state: "pending",
    dependencies: [],
    resourceLocks: [],
    ...overrides,
  }) as PlanTask;

const plan = (tasks: PlanTask[], kind = "build"): SessionPlan =>
  ({
    sessionId: "s1",
    goal: "goal",
    kind,
    status: "in_progress",
    tasks,
  }) as SessionPlan;

const harness = (mutateOk = true) => {
  const events: string[] = [];
  let ledger: TaskWorkLedger | null = null;
  const ports: ToolDispatchPorts = {
    mutatePlan: async (mutator) => {
      const draft = plan([task({ id: "t1", state: "in_progress" })]);
      const changed = mutator(draft);
      events.push(`mutate:${changed}`);
      return mutateOk ? { ok: true, plan: draft } : { ok: false };
    },
    renderPlan: () => events.push("render"),
    setPendingSessionStatePlan: () => events.push("pending"),
    notify: (level, message) => events.push(`${level}:${message}`),
    getLedger: () => ledger,
    setLedger: (next) => {
      ledger = next;
      events.push(`ledger:${next?.taskId ?? "none"}`);
    },
  };
  return { ports, events, ledger: () => ledger };
};

const shellCall: ToolCall = { name: "shell.exec", args: { command: "nmap x" } };

describe("tool dispatch", () => {
  it("uses the open foreground task as the dispatch target", async () => {
    const h = harness();
    const outcome = await resolveToolDispatch(
      h.ports,
      shellCall,
      plan([
        task({ id: "t0", state: "done" }),
        task({ id: "t1", state: "in_progress" }),
      ]),
    );
    expect(outcome).toMatchObject({ kind: "dispatch", dispatchedTaskId: "t1" });
    expect(h.ledger()?.taskId).toBe("t1");
  });

  it("ignores responder-owned tasks as the foreground target", async () => {
    const h = harness();
    const outcome = await resolveToolDispatch(
      h.ports,
      shellCall,
      plan([task({ id: "t1", state: "in_progress", responderOwned: true })]),
    );
    expect(outcome).toMatchObject({ dispatchedTaskId: undefined });
  });

  it("infers a pentest target from ready tasks when none is open", async () => {
    const h = harness();
    const outcome = await resolveToolDispatch(
      h.ports,
      shellCall,
      plan([task({ id: "t1", state: "pending" })], "pentest"),
    );
    expect(outcome).toMatchObject({ dispatchedTaskId: "t1" });
  });

  it("does not infer a target for a non-pentest plan", async () => {
    const h = harness();
    const outcome = await resolveToolDispatch(
      h.ports,
      shellCall,
      plan([task({ id: "t1", state: "pending" })]),
    );
    expect(outcome).toMatchObject({ dispatchedTaskId: undefined });
  });

  it("rejects an unresolvable declared parent", async () => {
    const h = harness();
    const outcome = await resolveToolDispatch(
      h.ports,
      { name: "shell.start", args: { command: "x", parentTaskId: "ghost" } },
      plan([task({ id: "t1", state: "in_progress" })]),
    );
    expect(outcome.kind).toBe("reject");
    if (outcome.kind !== "reject") throw new Error("expected reject");
    expect(outcome.reason).toContain("shell.start failed:");
  });

  it("keeps an existing ledger for the same dispatch target", async () => {
    const h = harness();
    h.ports.setLedger({ taskId: "t1", successWorkCount: 2 } as TaskWorkLedger);
    h.events.length = 0;
    await resolveToolDispatch(
      h.ports,
      shellCall,
      plan([task({ id: "t1", state: "in_progress" })]),
    );
    expect(h.events).toEqual([]);
    expect(h.ledger()?.successWorkCount).toBe(2);
  });

  it("creates a delegation child bound to the parent", async () => {
    const h = harness();
    const outcome = await resolveToolDispatch(
      h.ports,
      { name: "shell.exec", args: { command: "nmap -p- 10.0.0.1", responder: true } },
      plan([task({ id: "t1", state: "in_progress" })]),
    );
    if (outcome.kind !== "dispatch") throw new Error("expected dispatch");
    expect(outcome.delegation?.id).toMatch(/^dg-/);
    expect(outcome.delegation?.taskId).toBeDefined();
    expect(h.events).toContain("render");
    expect(h.events).toContain("pending");
  });

  it("warns and drops the delegation when it cannot be persisted", async () => {
    const h = harness(false);
    const outcome = await resolveToolDispatch(
      h.ports,
      { name: "shell.exec", args: { command: "nmap -p- 10.0.0.1", responder: true } },
      plan([task({ id: "t1", state: "in_progress" })]),
    );
    if (outcome.kind !== "dispatch") throw new Error("expected dispatch");
    expect(outcome.delegation).toBeUndefined();
    expect(h.events).toContain(
      "warn:Responder delegation record could not be persisted — the job will be linked after launch",
    );
  });

  it("creates no delegation without a live plan", async () => {
    const h = harness();
    const outcome = await resolveToolDispatch(
      h.ports,
      { name: "shell.exec", args: { command: "nmap -p- 10.0.0.1", responder: true } },
      undefined,
    );
    if (outcome.kind !== "dispatch") throw new Error("expected dispatch");
    expect(outcome.delegation).toBeUndefined();
  });
});
