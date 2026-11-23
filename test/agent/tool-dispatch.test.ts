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
  let renderedPlan: SessionPlan | undefined;
  const ports: ToolDispatchPorts = {
    mutatePlan: async (mutator) => {
      const draft = plan([task({ id: "t1", state: "in_progress" })]);
      const changed = mutator(draft);
      events.push(`mutate:${changed}`);
      return mutateOk ? { ok: true, plan: draft } : { ok: false };
    },
    renderPlan: (plan) => {
      renderedPlan = plan;
      events.push("render");
    },
    setPendingSessionStatePlan: () => events.push("pending"),
    notify: (level, message) => events.push(`${level}:${message}`),
    getLedger: () => ledger,
    setLedger: (next) => {
      ledger = next;
      events.push(`ledger:${next?.taskId ?? "none"}`);
    },
  };
  return { ports, events, ledger: () => ledger, renderedPlan: () => renderedPlan };
};

const shellCall: ToolCall = { name: "shell.exec", args: { command: "nmap x" } };
const responderCall: ToolCall = {
  name: "shell.exec",
  args: { command: "npm test -- --reporter=verbose", name: "  Run  test suite  ", responder: true },
};

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
      { name: "shell.exec", args: { command: "echo x", name: "Print message", parentTaskId: "ghost", background: "always" } },
      plan([task({ id: "t1", state: "in_progress" })]),
    );
    expect(outcome).toMatchObject({ kind: "reject", reason: expect.stringContaining('parentTaskId "ghost"') });
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

  it.each([{ responder: true }, { background: "always" }])("rejects an unnamed job without plan side effects (%j)", async (mode) => {
    const h = harness();
    const outcome = await resolveToolDispatch(
      h.ports,
      { name: "shell.exec", args: { command: "npm test", ...mode } },
      plan([task({ id: "t1", state: "in_progress" })]),
    );
    expect(outcome).toMatchObject({ kind: "reject", reason: expect.stringContaining('short "name"') });
    expect(h.events).toEqual([]);
  });

  it("does not delegate a foreground override", async () => {
    const h = harness();
    const outcome = await resolveToolDispatch(
      h.ports,
      { name: "shell.exec", args: { command: "npm test", responder: true, background: "never" } },
      plan([task({ id: "t1", state: "in_progress" })]),
    );
    expect(outcome).toMatchObject({ kind: "dispatch", dispatchedTaskId: "t1", delegation: undefined });
    expect(h.events).toEqual(["ledger:t1"]);
  });

  it("creates a named delegation child bound to the parent", async () => {
    const h = harness();
    const outcome = await resolveToolDispatch(
      h.ports,
      responderCall,
      plan([task({ id: "t1", state: "in_progress" })]),
    );
    if (outcome.kind !== "dispatch") throw new Error("expected dispatch");
    expect(outcome.delegation?.id).toMatch(/^dg-/);
    expect(outcome.delegation?.taskId).toBeDefined();
    expect(h.renderedPlan()?.tasks.at(-1)).toMatchObject({
      title: "Run test suite",
      parentTaskId: "t1",
      responderOwned: true,
    });
    expect(h.events).toContain("render");
    expect(h.events).toContain("pending");
  });

  it("warns and drops the delegation when it cannot be persisted", async () => {
    const h = harness(false);
    const outcome = await resolveToolDispatch(
      h.ports,
      responderCall,
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
      responderCall,
      undefined,
    );
    if (outcome.kind !== "dispatch") throw new Error("expected dispatch");
    expect(outcome.delegation).toBeUndefined();
  });
});
