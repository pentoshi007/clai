import { describe, expect, it } from "vitest";
import {
  budgetRemaining,
  consumeBudget,
  createRecoveryBudgets,
  looksLikeShallowPentestReport,
  recoveryForMissingFeature,
  recoveryForShallowPentest,
} from "../src/agent/must-continue.js";
import { shouldYieldForDeclaredResponderDependency } from "../src/agent/runner.js";
import { appendPlanTask, createPlan } from "../src/store/plan.js";
import { outOfScopeToolMessage, scopeContextMessage } from "../src/agent/scope-context.js";
import { isReadOnlyReconTool } from "../src/agent/task-evidence.js";

describe("recovery budgets", () => {
  it("tracks and exhausts budgets", () => {
    const b = createRecoveryBudgets();
    expect(budgetRemaining(b, "forcePlan")).toBe(true);
    consumeBudget(b, "forcePlan");
    consumeBudget(b, "forcePlan");
    expect(budgetRemaining(b, "forcePlan")).toBe(false);
  });

  it("builds feature messages", () => {
    expect(recoveryForMissingFeature("/tmp/app").message).toMatch(/feature/i);
  });
});

describe("shallow pentest report", () => {
  it("flags ports-only write-ups without deep tests", () => {
    expect(
      looksLikeShallowPentestReport(
        "Assessment complete. Open ports 80, 443. Server header nginx. Missing security headers noted.",
        { productiveSteps: 5, sawActiveTest: false },
      ),
    ).toBe(true);
    expect(
      looksLikeShallowPentestReport(
        "Confirmed IDOR on /api/users/{id} — accessed another user's data. PoC attached.",
        { productiveSteps: 5, sawActiveTest: false },
      ),
    ).toBe(false);
    expect(
      looksLikeShallowPentestReport(
        "Open ports 80 and 443 only.",
        { productiveSteps: 5, sawActiveTest: true },
      ),
    ).toBe(false);
    expect(recoveryForShallowPentest().message).toMatch(/threat model/i);
  });
});

describe("read-only recon tools", () => {
  it("allows recon tools without task bracket", () => {
    expect(isReadOnlyReconTool("dns.lookup")).toBe(true);
    expect(isReadOnlyReconTool("http.fetch")).toBe(true);
    expect(isReadOnlyReconTool("net.scan")).toBe(true);
    expect(isReadOnlyReconTool("fs.write")).toBe(false);
    expect(isReadOnlyReconTool("shell.exec")).toBe(false);
  });
});

describe("scope context", () => {
  it("renders authorized and excluded targets", () => {
    const msg = scopeContextMessage({
      name: "acme",
      authorizedTargets: ["app.example.com"],
      excludedTargets: ["blog.example.com"],
      createdAt: new Date().toISOString(),
    });
    expect(msg).toMatch(/ENGAGEMENT SCOPE/);
    expect(msg).toContain("app.example.com");
    expect(msg).toContain("blog.example.com");
    expect(msg).toContain("do not stop");
  });

  it("returns a model-facing refusal that continues in-scope work", () => {
    const message = outOfScopeToolMessage({
      target: "other.example.com",
      reason: "target is not authorized",
      allowed: ["app.example.com"],
    });
    expect(message).toContain("OUT_OF_SCOPE");
    expect(message).toContain("tool call was not run");
    expect(message).toContain("app.example.com");
    expect(message).toContain("Continue the task");
    expect(message).toContain("do not end the agent");
  });

  it("returns undefined when inactive", () => {
    expect(scopeContextMessage(undefined)).toBeUndefined();
    expect(
      scopeContextMessage({ authorizedTargets: [], createdAt: "x" }),
    ).toBeUndefined();
  });
});


describe("declared responder dependency deferral (TASK-004)", () => {
  function planWithChild() {
    const plan = createPlan({
      sessionId: "report-yield",
      goal: "assessment",
      detail: "test then report",
      kind: "pentest",
      taskTitles: ["Enumerate endpoints", "Compile final report"],
    });
    plan.tasks[0]!.state = "done";
    plan.tasks[1]!.state = "pending";
    appendPlanTask(plan, {
      title: "Responder · nmap",
      state: "in_progress",
      dependencies: [],
      resourceLocks: [],
      parentTaskId: plan.tasks[0]!.id,
      jobId: "job-1",
      responderOwned: true,
    });
    return plan;
  }

  const child = (plan: ReturnType<typeof planWithChild>) =>
    plan.tasks.find((task) => task.responderOwned)!;
  const report = (plan: ReturnType<typeof planWithChild>) =>
    plan.tasks.find((task) => task.title === "Compile final report")!;
  const enumerate = (plan: ReturnType<typeof planWithChild>) =>
    plan.tasks.find((task) => task.title === "Enumerate endpoints")!;

  it("does not yield for a running responder that no task depends on", () => {
    const plan = planWithChild();
    expect(
      shouldYieldForDeclaredResponderDependency(
        plan,
        [{ id: "job-1", responder: true } as never],
        [],
      ),
    ).toBe(false);
  });

  it("yields when the remaining task declares the live child as a dependency", () => {
    const plan = planWithChild();
    report(plan).dependencies = [child(plan).id];
    expect(
      shouldYieldForDeclaredResponderDependency(
        plan,
        [{ id: "job-1", responder: true } as never],
        [],
      ),
    ).toBe(true);
  });

  it("yields on an undelivered receipt for the declared child", () => {
    const plan = planWithChild();
    report(plan).dependencies = [child(plan).id];
    expect(
      shouldYieldForDeclaredResponderDependency(
        plan,
        [],
        [{ id: "n1", jobId: "job-1", responder: true } as never],
      ),
    ).toBe(true);
    expect(
      shouldYieldForDeclaredResponderDependency(
        plan,
        [],
        [{ id: "n1", jobId: "job-1", responder: true } as never],
        "n1",
      ),
    ).toBe(false);
    expect(
      shouldYieldForDeclaredResponderDependency(
        plan,
        [],
        [{ id: "n1", jobId: "job-1", responder: true, analyzedAt: "t" } as never],
      ),
    ).toBe(false);
  });

  it("does not yield when the declared child is orphaned or settled", () => {
    const plan = planWithChild();
    report(plan).dependencies = [child(plan).id];
    expect(shouldYieldForDeclaredResponderDependency(plan, [], [])).toBe(false);
    child(plan).state = "done";
    expect(
      shouldYieldForDeclaredResponderDependency(
        plan,
        [{ id: "job-1", responder: true } as never],
        [],
      ),
    ).toBe(false);
  });

  it("does not yield while other foreground work is executable", () => {
    const plan = planWithChild();
    enumerate(plan).state = "pending";
    report(plan).dependencies = [child(plan).id];
    expect(
      shouldYieldForDeclaredResponderDependency(
        plan,
        [{ id: "job-1", responder: true } as never],
        [],
      ),
    ).toBe(false);
  });
});
