import { describe, expect, it } from "vitest";
import { appendPlanTask, createPlan } from "../src/store/plan.js";
import {
  readDeclaredParentTaskId,
  resolveResponderParent,
} from "../src/agent/responder-parent.js";
import { TOOL_DEFINITIONS } from "../src/tools/definitions.js";

function plan() {
  const built = createPlan({
    sessionId: "parent-own",
    goal: "assess",
    detail: "d",
    kind: "pentest",
    taskTitles: ["Enumerate", "Fuzz", "Report"],
  });
  built.tasks[0]!.state = "done";
  built.tasks[1]!.state = "in_progress";
  appendPlanTask(built, {
    title: "Responder · ffuf",
    state: "in_progress",
    dependencies: [],
    resourceLocks: [],
    parentTaskId: built.tasks[1]!.id,
    jobId: "job-1",
    responderOwned: true,
  });
  return built;
}

describe("responder parent ownership (TASK-005)", () => {
  it("exposes parentTaskId only on tools that can create Responder children", () => {
    for (const name of ["shell.exec"]) {
      const def = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
      expect(def, name).toBeDefined();
      const properties = (def!.parameters as any).properties ?? {};
      expect(Object.keys(properties), name).toContain("parentTaskId");
      expect(Object.keys(properties), name).not.toContain("taskId");
    }
  });

  it("reads only a non-empty declared parent", () => {
    expect(
      readDeclaredParentTaskId({ name: "shell.exec", args: { parentTaskId: " t2 " } }),
    ).toBe("t2");
    expect(
      readDeclaredParentTaskId({ name: "shell.exec", args: { parentTaskId: "  " } }),
    ).toBeUndefined();
    expect(readDeclaredParentTaskId({ name: "shell.exec", args: {} })).toBeUndefined();
  });

  it("accepts a declared foreground parent", () => {
    const live = plan();
    expect(
      resolveResponderParent({
        plan: live,
        declared: live.tasks.find((task) => task.title === "Report")!.id,
        activeForegroundTaskIds: [live.tasks[1]!.id],
      }),
    ).toMatchObject({ ok: true, source: "declared" });
  });

  it("rejects unknown, responder-owned, and settled parents", () => {
    const live = plan();
    expect(
      resolveResponderParent({
        plan: live,
        declared: "t99",
        activeForegroundTaskIds: [],
      }),
    ).toMatchObject({ ok: false });
    expect(
      resolveResponderParent({
        plan: live,
        declared: live.tasks.find((task) => task.responderOwned)!.id,
        activeForegroundTaskIds: [],
      }),
    ).toMatchObject({ ok: false });
    expect(
      resolveResponderParent({
        plan: live,
        declared: live.tasks.find((task) => task.title === "Enumerate")!.id,
        activeForegroundTaskIds: [],
      }),
    ).toMatchObject({ ok: false });
  });

  it("falls back to the single active foreground task when omitted", () => {
    const live = plan();
    expect(
      resolveResponderParent({
        plan: live,
        declared: undefined,
        activeForegroundTaskIds: [live.tasks[1]!.id],
      }),
    ).toEqual({ ok: true, taskId: live.tasks[1]!.id, source: "active-fallback" });
    expect(
      resolveResponderParent({
        plan: live,
        declared: undefined,
        activeForegroundTaskIds: [],
      }),
    ).toEqual({ ok: true, taskId: undefined, source: "none" });
  });
});
