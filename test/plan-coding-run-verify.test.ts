import { afterEach, describe, expect, it } from "vitest";
import {
  codingPlanNeedsRunVerifyTask,
  handlePlanTool,
  looksLikeRunServerTask,
} from "../src/agent/plan-tool.js";
import { LoopGuard } from "../src/agent/loop-guard.js";
import { createSessionPolicy } from "../src/agent/session-policy.js";
import {
  clearAllPlans,
  createPlan,
  loadPlan,
  savePlan,
} from "../src/store/plan.js";

describe("coding plan run/verify (X12)", () => {
  afterEach(async () => {
    await clearAllPlans();
  });

  it("detects run-server style final tasks", () => {
    expect(
      looksLikeRunServerTask(
        "Start dev server (shell.start), probe localhost, leave running",
      ),
    ).toBe(true);
    expect(looksLikeRunServerTask("npm run build")).toBe(false);
    expect(looksLikeRunServerTask("implement App.jsx UI")).toBe(false);
  });

  it("requires run/verify for local app coding plans", () => {
    expect(
      codingPlanNeedsRunVerifyTask(
        "coding",
        "Build a React todo app with Vite",
        "Vite + React",
        ["scaffold", "implement UI", "npm run build"],
      ),
    ).toBe(true);
    expect(
      codingPlanNeedsRunVerifyTask(
        "coding",
        "Build a React todo app with Vite",
        "Vite + React",
        [
          "scaffold",
          "implement UI",
          "npm run build",
          "Start dev server, probe localhost, leave running, report URL",
        ],
      ),
    ).toBe(false);
  });

  it("plan.create coding preserves an authored build-only checklist", async () => {
    const authored = [
      "scaffold with create-vite",
      "implement todo UI",
      "verify with npm run build",
    ];
    const result = await handlePlanTool(
      {
        name: "plan.create",
        args: {
          goal: "Scaffold a Vite React todo app",
          detail: "Vite + React SPA",
          kind: "coding",
          tasks: authored,
        },
      },
      createSessionPolicy("x12-no-run"),
      { loopGuard: new LoopGuard(), step: 1 },
    );
    expect(result.ok).toBe(true);
    expect(result.plan?.tasks.map((task) => task.title)).toEqual(authored);
    expect(result.plan?.tasks.map((task) => task.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("plan.create coding with final run-server task succeeds", async () => {
    const result = await handlePlanTool(
      {
        name: "plan.create",
        args: {
          goal: "Scaffold a Vite React todo app",
          detail: "Vite + React SPA",
          kind: "coding",
          tasks: [
            "scaffold with create-vite",
            "implement todo UI",
            "verify with npm run build",
            "Start dev server (shell.start), tail ready, probe localhost, leave running, report URL/port/job id",
          ],
        },
      },
      createSessionPolicy("x12-with-run"),
      { loopGuard: new LoopGuard(), step: 1 },
    );
    expect(result.ok).toBe(true);
    expect(result.plan?.tasks).toHaveLength(4);
    expect(result.plan?.tasks.some((t) => /install/i.test(t.title))).toBe(false);
    expect(result.plan?.tasks.map((task) => task.id)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(
      result.plan?.tasks.some((t) => /dev server|shell\.start|localhost/i.test(t.title)),
    ).toBe(true);
  });

  it("does not require run-server for pure library coding", async () => {
    const result = await handlePlanTool(
      {
        name: "plan.create",
        args: {
          goal: "Publish a small TypeScript CLI library",
          detail: "CLI package, no web server",
          kind: "coding",
          tasks: ["init package", "implement commands", "run unit tests"],
        },
      },
      createSessionPolicy("x12-cli-lib"),
      { loopGuard: new LoopGuard(), step: 1 },
    );
    expect(result.ok).toBe(true);
  });
});

describe("plan merge no-reboot (X7)", () => {
  afterEach(async () => {
    await clearAllPlans();
  });

  it("keeps prior done tasks done and only new task pending; keeps approval", async () => {
    const session = createSessionPolicy("x7-merge");
    const prior = createPlan({
      sessionId: "x7-merge",
      goal: "Vite React todo",
      detail: "app",
      kind: "coding",
      taskTitles: [
        "scaffold project",
        "implement UI",
        "verify build",
        "Start dev server, probe localhost, leave running, report URL",
      ],
    });
    prior.tasks[0]!.state = "done";
    prior.tasks[1]!.state = "done";
    prior.tasks[2]!.state = "done";
    prior.tasks[3]!.state = "done";
    prior.status = "completed";
    await savePlan(prior);
    session.planApproved.value = true;

    const result = await handlePlanTool(
      {
        name: "plan.create",
        args: {
          goal: "Vite React todo",
          detail: "app + extra polish",
          kind: "coding",
          tasks: [
            "scaffold project",
            "implement UI",
            "verify build",
            "Start dev server, probe localhost, leave running, report URL",
            "Add README with run instructions",
          ],
        },
      },
      session,
      { loopGuard: new LoopGuard(), step: 2 },
    );

    expect(result.ok).toBe(true);
    const loaded = await loadPlan("x7-merge");
    expect(loaded).toBeDefined();
    expect(loaded!.tasks[0]!.state).toBe("done");
    expect(loaded!.tasks[1]!.state).toBe("done");
    expect(loaded!.tasks[2]!.state).toBe("done");
    expect(loaded!.tasks[3]!.state).toBe("done");
    expect(loaded!.tasks[4]!.state).toBe("pending");
    // Additive merge keeps approval so implement does not reboot at t1.
    expect(session.planApproved.value).toBe(true);
    expect(result.modelNote).toMatch(/do NOT re-execute|stay done|Continue from/i);
  });

  it("rejects run-only plan.create after completed plan", async () => {
    const prior = createPlan({
      sessionId: "x7-run-only",
      goal: "todo app",
      detail: "done",
      kind: "coding",
      taskTitles: [
        "scaffold",
        "implement",
        "build",
        "Start dev server and leave running",
      ],
    });
    for (const t of prior.tasks) t.state = "done";
    prior.status = "completed";
    await savePlan(prior);

    const result = await handlePlanTool(
      {
        name: "plan.create",
        args: {
          goal: "Run the existing app and start the dev server",
          detail: "verify it works on the existing project",
          kind: "coding",
          tasks: [
            "Start the existing app with shell.start",
            "Probe localhost and leave the server running",
          ],
        },
      },
      createSessionPolicy("x7-run-only"),
      { loopGuard: new LoopGuard(), step: 1 },
    );
    expect(result.ok).toBe(false);
    expect(result.modelNote).toMatch(/shell\.start|Do NOT create a new plan/i);
  });

  it("allows re-opening a done task", async () => {
    const session = createSessionPolicy("x-reopen-done");
    const plan = createPlan({
      sessionId: "x-reopen-done",
      goal: "blog app",
      detail: "app",
      kind: "coding",
      taskTitles: [
        "scaffold",
        "implement",
        "Leave server running for user to test",
      ],
    });
    plan.tasks[0]!.state = "done";
    plan.tasks[1]!.state = "done";
    plan.tasks[2]!.state = "pending";
    plan.status = "in_progress";
    await savePlan(plan);
    session.planApproved.value = true;

    const result = await handlePlanTool(
      {
        name: "task.update",
        args: { taskId: "t1", state: "in_progress" },
      },
      session,
      { loopGuard: new LoopGuard(), step: 1 },
    );
    expect(result.ok).toBe(true);
    const live = await loadPlan("x-reopen-done");
    expect(live!.tasks.find((t) => t.id === "t1")?.state).toBe("in_progress");
  });
});
