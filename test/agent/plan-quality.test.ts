import { afterEach, describe, expect, it } from "vitest";
import { handlePlanTool } from "../../src/agent/plan-tool.js";
import { planContextMessage } from "../../src/agent/plan/context-message.js";
import { normalizeTaskSteps } from "../../src/agent/plan/normalization.js";
import { PLAN_DETAIL_MIN_CHARS, planDraftGaps } from "../../src/agent/plan/quality.js";
import { LoopGuard } from "../../src/agent/loop-guard.js";
import { createSessionPolicy } from "../../src/agent/session-policy.js";
import { formatPlanPagerDocument } from "../../src/ui-core/rendering/plan-view.js";
import { clearAllPlans, loadPlan } from "../../src/store/plan.js";
import type { ToolCall } from "../../src/types.js";

const detail = `SCOPE: retry webhook deliveries. EVIDENCE: src/webhooks/deliver.ts sends once. ${"Risks and validation are listed. ".repeat(10)}`;

const completeTasks = [
  {
    title: "Retry failed deliveries",
    steps: ["Wrap sendDelivery in retryWithBackoff in src/webhooks/deliver.ts", "Skip retries for 4xx"],
    acceptanceCriteria: "5xx retried three times; 4xx not retried",
  },
  {
    title: "Cover retries with tests",
    steps: "- Add 503 then 200 case\n- Add exhausted retry case",
    acceptanceCriteria: "npm test passes",
    note: "mirror existing fixtures",
  },
];

const planCreate = (args: ToolCall["args"]): ToolCall => ({ name: "plan.create", args });

const run = (sessionId: string, call: ToolCall, qualityGate: boolean, autoApprove = false) =>
  handlePlanTool(call, createSessionPolicy(sessionId), {
    loopGuard: new LoopGuard(),
    step: 1,
    autoApprove,
    qualityGate,
  });

describe("plan draft quality", () => {
  afterEach(async () => {
    await clearAllPlans();
  });

  it("normalizes steps from arrays, bullet text, and numbered text", () => {
    expect(normalizeTaskSteps(["  a ", "", 3, "b"])).toEqual(["a", "b"]);
    expect(normalizeTaskSteps("- first\n2) second\n\n3. third")).toEqual(["first", "second", "third"]);
    expect(normalizeTaskSteps(undefined)).toEqual([]);
  });

  it("lists thin detail and tasks without steps or acceptance criteria by position", () => {
    const gaps = planDraftGaps({
      detail: "short",
      entries: [
        { title: "a", aliases: [], dependencies: [], dependenciesSpecified: false, resourceLocks: [], steps: ["x"], acceptanceCriteria: "ok" },
        { title: "b", aliases: [], dependencies: [], dependenciesSpecified: false, resourceLocks: [], steps: [] },
      ],
    });
    expect(gaps).toHaveLength(3);
    expect(gaps[0]).toContain(`detail has 5 characters`);
    expect(gaps[1]).toContain("tasks #2 need steps");
    expect(gaps[2]).toContain("tasks #2 need observable acceptanceCriteria");
    expect(planDraftGaps({ detail: "x".repeat(PLAN_DETAIL_MIN_CHARS), entries: [] })).toEqual([]);
  });

  it("rejects a thin plan-mode draft without saving it", async () => {
    const result = await run("thin", planCreate({ goal: "Retry webhooks", detail: "short", kind: "coding", tasks: ["Do it", "Test it"] }), true);
    expect(result.ok).toBe(false);
    expect(result.qualityRejected).toBe(true);
    expect(result.modelNote).toContain("tasks #1, #2 need steps");
    expect(await loadPlan("thin")).toBeUndefined();
  });

  it("accepts the same draft once the gate is spent and outside plan mode", async () => {
    const thin = planCreate({ goal: "Retry webhooks", detail: "short", kind: "coding", tasks: ["Do it", "Test it"] });
    expect((await run("spent", thin, false)).ok).toBe(true);
    expect((await run("auto", thin, true, true)).ok).toBe(true);
  });

  it("saves steps and notes and surfaces them in the plan context and the plan view", async () => {
    const result = await run("complete", planCreate({ goal: "Retry webhooks", detail, kind: "coding", tasks: completeTasks }), true);
    expect(result.ok).toBe(true);
    const plan = (await loadPlan("complete"))!;
    expect(plan.tasks.map((task) => task.steps)).toEqual([
      ["Wrap sendDelivery in retryWithBackoff in src/webhooks/deliver.ts", "Skip retries for 4xx"],
      ["Add 503 then 200 case", "Add exhausted retry case"],
    ]);
    expect(plan.tasks[1]!.note).toBe("mirror existing fixtures");

    const context = planContextMessage(plan, false);
    expect(context).toContain("     - Wrap sendDelivery in retryWithBackoff in src/webhooks/deliver.ts");
    const done = { ...plan, tasks: plan.tasks.map((task, index) => (index === 0 ? { ...task, state: "done" as const } : task)) };
    expect(planContextMessage(done, true)).not.toContain("Skip retries for 4xx");
    expect(planContextMessage(done, true)).toContain("     - Add exhausted retry case");

    const view = formatPlanPagerDocument(plan);
    expect(view).toContain("## Task details");
    expect(view).toContain("### 1. Retry failed deliveries\n\n1. Wrap sendDelivery");
    expect(view).toContain("**Done when:** npm test passes");
  });

  it("keeps earlier steps when a revision omits them for the same task", async () => {
    await run("revise", planCreate({ goal: "Retry webhooks", detail, kind: "coding", tasks: completeTasks }), true);
    const revised = await run("revise", planCreate({
      goal: "Retry webhooks",
      detail,
      kind: "coding",
      tasks: [{ title: "Retry failed deliveries", acceptanceCriteria: "5xx retried" }, completeTasks[1]!],
    }), false);
    expect(revised.ok).toBe(true);
    const plan = (await loadPlan("revise"))!;
    expect(plan.tasks[0]!.steps).toEqual(completeTasks[0]!.steps);
    expect(plan.tasks[0]!.acceptanceCriteria).toBe("5xx retried");
  });
});
