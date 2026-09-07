import { describe, expect, it } from "vitest";
import { appendPlanTask, createPlan } from "../src/store/plan.js";
import {
  delegationTaskTitle,
  isExplicitResponderDelegation,
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
    const shellStart = TOOL_DEFINITIONS.find(
      (candidate) => candidate.name === "shell.start",
    );
    expect(Object.keys(shellStart?.parameters.properties ?? {})).not.toContain(
      "parentTaskId",
    );
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


describe("explicit responder delegation", () => {
  it("applies foreground and persistent precedence before creating a child", () => {
    expect(
      isExplicitResponderDelegation({
        name: "shell.exec",
        args: { command: "ffuf -u x", responder: true },
      }),
    ).toBe(true);
    expect(
      isExplicitResponderDelegation({
        name: "shell.exec",
        args: {
          command: "ffuf -u x",
          responder: true,
          background: "never",
        },
      }),
    ).toBe(false);
    expect(
      isExplicitResponderDelegation({
        name: "shell.exec",
        args: { command: "npm run dev", responder: true },
      }),
    ).toBe(false);
    expect(
      isExplicitResponderDelegation({
        name: "shell.start",
        args: { command: "npm run dev", responder: true },
      }),
    ).toBe(false);
    expect(
      isExplicitResponderDelegation({
        name: "shell.exec",
        args: { command: "ls" },
      }),
    ).toBe(false);
    expect(
      isExplicitResponderDelegation({
        name: "fs.read",
        args: { path: "a", responder: true },
      }),
    ).toBe(false);
  });

  it("derives a bounded child title from the command or target", () => {
    expect(
      delegationTaskTitle({ name: "shell.exec", args: { command: "nmap -p- host" } }),
    ).toBe("Responder · nmap -p- host");
    expect(
      delegationTaskTitle({ name: "shell.exec", args: { command: "nmap 10.0.0.1" } }),
    ).toBe("Responder · nmap 10.0.0.1");
    const long = delegationTaskTitle({
      name: "shell.exec",
      args: { command: "x".repeat(200) },
    });
    expect(long.length).toBe("Responder · ".length + 96);
  });
});
