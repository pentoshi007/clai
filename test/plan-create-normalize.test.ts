import { afterEach, describe, expect, it } from "vitest";
import {
  handlePlanTool,
  planContextMessage,
} from "../src/agent/plan-tool.js";
import { LoopGuard } from "../src/agent/loop-guard.js";
import { createSessionPolicy } from "../src/agent/session-policy.js";
import { clearAllPlans } from "../src/store/plan.js";

describe("plan.create robust arg normalization", () => {
  afterEach(async () => {
    await clearAllPlans();
  });

  it("accepts tasks as {title} objects", async () => {
    const result = await handlePlanTool(
      {
        name: "plan.create",
        args: {
          goal: "Assess target.example",
          detail: "Recon then report",
          kind: "pentest",
          tasks: [
            { id: "t1", title: "DNS enumeration" },
            { title: "Port scan" },
            { name: "HTTP fingerprint" },
          ],
        },
      },
      createSessionPolicy("plan-obj-tasks"),
      { loopGuard: new LoopGuard(), step: 1 },
    );
    expect(result.ok).toBe(true);
    expect(result.plan?.tasks.map((t) => t.title)).toEqual([
      "DNS enumeration",
      "Port scan",
      "HTTP fingerprint",
    ]);
  });

  it("preserves task outcomes, acceptance evidence, dependencies, and resource locks", async () => {
    const result = await handlePlanTool(
      {
        name: "plan.create",
        args: {
          goal: "Harden request pipeline",
          detail: "Trace contracts, implement, and verify regressions",
          kind: "hardening",
          tasks: [
            {
              id: "map",
              title: "Map request contracts and failure modes",
              acceptanceCriteria:
                "Every touched caller, schema, trust boundary, and material error path is identified",
              dependencies: [],
              resourceLocks: ["request-pipeline"],
            },
            {
              id: "implement",
              title: "Implement the validated hardening changes",
              successCriteria: [
                "Required behavior is implemented",
                "Existing contract invariants are preserved",
              ],
              dependencies: ["map"],
              resourceLocks: ["request-pipeline"],
            },
          ],
        },
      },
      createSessionPolicy("plan-acceptance-criteria"),
      { loopGuard: new LoopGuard(), step: 1 },
    );

    expect(result.ok).toBe(true);
    expect(result.plan?.tasks[0]).toMatchObject({
      acceptanceCriteria:
        "Every touched caller, schema, trust boundary, and material error path is identified",
      dependencies: [],
      resourceLocks: ["request-pipeline"],
    });
    expect(result.plan?.tasks[1]).toMatchObject({
      acceptanceCriteria:
        "Required behavior is implemented; Existing contract invariants are preserved",
      dependencies: ["t1"],
      resourceLocks: ["request-pipeline"],
    });

    const context = planContextMessage(result.plan!, false);
    expect(context).toContain(
      "acceptance: Every touched caller, schema, trust boundary, and material error path is identified",
    );
    expect(context).toContain(
      "acceptance: Required behavior is implemented; Existing contract invariants are preserved",
    );

    const approved = planContextMessage(result.plan!, true);
    expect(approved).toContain("living outcome map rather than an inflexible script");
    expect(approved).toContain("return the current task to pending");
    expect(approved).toContain("Capture unrelated or newly required discoveries with task.add");
    expect(approved).toContain("reconcile every requested acceptance criterion");
    expect(approved).not.toContain("Do ONLY this task's work");
  });

  it("accepts tasks as a newline-separated string", async () => {
    const result = await handlePlanTool(
      {
        name: "plan.create",
        args: {
          goal: "Build todo app",
          tasks:
            "scaffold project\nimplement UI\nverify build\nstart dev server, probe localhost, leave running, report URL",
          kind: "coding",
        },
      },
      createSessionPolicy("plan-string-tasks"),
      { loopGuard: new LoopGuard(), step: 1 },
    );
    expect(result.ok).toBe(true);
    expect(result.plan?.tasks.map((task) => task.title)).toEqual([
      "scaffold project",
      "implement UI",
      "verify build",
      "start dev server, probe localhost, leave running, report URL",
    ]);
    expect(result.plan?.tasks.some((t) => /install/i.test(t.title))).toBe(false);
  });

  it("still rejects empty goal/tasks with a helpful note", async () => {
    const result = await handlePlanTool(
      {
        name: "plan.create",
        args: { goal: "", tasks: [] },
      },
      createSessionPolicy("plan-empty"),
      { loopGuard: new LoopGuard(), step: 1 },
    );
    expect(result.ok).toBe(false);
    expect(result.modelNote).toMatch(/tasks array/i);
  });

  it("drops bare tN strings interleaved as fake tasks", async () => {
    const result = await handlePlanTool(
      {
        name: "plan.create",
        args: {
          goal: "Deep security assessment of example.com",
          detail: "Exploit after recon",
          kind: "pentest",
          tasks: [
            "Analyze JavaScript bundles for secrets",
            "t1",
            "Test SSRF with bypass techniques",
            "t2",
            { title: "t3" },
            { id: "t4", title: "Fuzz API endpoints" },
            "t5",
            "Compile final report",
          ],
        },
      },
      createSessionPolicy("plan-bare-ids"),
      { loopGuard: new LoopGuard(), step: 1 },
    );
    expect(result.ok).toBe(true);
    expect(result.plan?.tasks.map((t) => t.title)).toEqual([
      "Analyze JavaScript bundles for secrets",
      "Test SSRF with bypass techniques",
      "Fuzz API endpoints",
      "Compile final report",
    ]);
    expect(result.plan?.tasks.map((t) => t.id)).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
    ]);
    expect(result.plan?.tasks.every((t) => !/^t\d+$/i.test(t.title))).toBe(
      true,
    );
  });
});
