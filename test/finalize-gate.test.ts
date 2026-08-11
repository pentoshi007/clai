import { describe, expect, it } from "vitest";
import {
  chooseFinalizeRecovery,
  type FinalizeGateInput,
  type FinalizeGatePlan,
} from "../src/agent/finalize-gate.js";
import {
  consumeBudget,
  createRecoveryBudgets,
  recoveryForNarration,
  type RecoveryBudgets,
} from "../src/agent/must-continue.js";

const NEUTRAL_ANSWER = "All done. Here is the summary of the finished work.";
const ERROR_FIX_TEXT =
  "The build failed with a TypeError in src/app.ts. I need to fix the import path.";
const SHALLOW_PENTEST_TEXT =
  "Assessment complete. Open ports 80, 443. Server header nginx. Missing security headers noted.";

function baseInput(overrides: Partial<FinalizeGateInput> = {}): FinalizeGateInput {
  return {
    cleaned: NEUTRAL_ANSWER,
    recovery: createRecoveryBudgets(),
    toolsAttached: true,
    productiveSteps: 3,
    planApproved: false,
    planHasOpenWork: false,
    activePlanExists: false,
    wantsAction: false,
    narratedAction: false,
    narratedWebAction: false,
    isPlanMode: false,
    buildLikeTurn: false,
    pentestLikeTurn: false,
    buildLike: false,
    pentestLike: false,
    pentestSession: false,
    informationalQuery: false,
    idleOrSocialPrompt: false,
    sawPlanCreateOk: false,
    sawFeatureImplWrite: false,
    sawScaffoldOk: false,
    sawLocalAppMaterialWork: false,
    sawServerStart: false,
    sawServerTail: false,
    sawLocalHttpProbe: false,
    sawFailedLocalHttpProbe: false,
    serverCriterionRequired: false,
    sawActivePentestTest: false,
    sawSuccessfulMutation: false,
    featureAppAsk: false,
    projectRoot: undefined,
    plan: undefined,
    deferResponderReport: false,
    ...overrides,
  };
}

function drained(key: keyof RecoveryBudgets, times: number): RecoveryBudgets {
  const budgets = createRecoveryBudgets();
  for (let i = 0; i < times; i += 1) consumeBudget(budgets, key);
  return budgets;
}

function planWith(
  tasks: FinalizeGatePlan["tasks"],
  overrides: Partial<FinalizeGatePlan> = {},
): FinalizeGatePlan {
  return {
    kind: "coding",
    hasVerifiedRuntime: false,
    tasks,
    ...overrides,
  };
}

describe("finalize gate — no recovery", () => {
  it("lets a plain finished answer finalize", () => {
    expect(chooseFinalizeRecovery(baseInput())).toBeUndefined();
  });

  it("never mutates the budgets it reads", () => {
    const recovery = createRecoveryBudgets();
    const before = { ...recovery };
    chooseFinalizeRecovery(
      baseInput({
        recovery,
        cleaned: ERROR_FIX_TEXT,
        wantsAction: true,
        productiveSteps: 0,
      }),
    );
    expect(recovery).toEqual(before);
  });

  it("fires nothing for an informational query", () => {
    expect(
      chooseFinalizeRecovery(
        baseInput({
          cleaned: "Let me explore the project directory next.",
          informationalQuery: true,
          isPlanMode: true,
          narratedAction: true,
          wantsAction: false,
          productiveSteps: 0,
        }),
      ),
    ).toBeUndefined();
  });

  it("fires nothing for an idle or social prompt", () => {
    expect(
      chooseFinalizeRecovery(
        baseInput({
          cleaned: "Hey! What would you like me to work on?",
          idleOrSocialPrompt: true,
          isPlanMode: true,
          wantsAction: false,
          productiveSteps: 0,
        }),
      ),
    ).toBeUndefined();
  });
});

describe("finalize gate — narration family", () => {
  const narrating = (overrides: Partial<FinalizeGateInput> = {}) =>
    baseInput({ wantsAction: true, productiveSteps: 0, ...overrides });

  it("prefers errorFix over every narration mode", () => {
    const action = chooseFinalizeRecovery(
      narrating({
        cleaned: ERROR_FIX_TEXT,
        planApproved: true,
        planHasOpenWork: true,
        pentestLikeTurn: true,
        buildLikeTurn: true,
      }),
    );
    expect(action?.kind).toBe("error_fix");
    expect(action?.budgetKey).toBe("errorFix");
  });

  it("falls back to narration once the errorFix budget is spent", () => {
    const action = chooseFinalizeRecovery(
      narrating({
        recovery: drained("errorFix", 3),
        cleaned: ERROR_FIX_TEXT,
        planApproved: true,
        planHasOpenWork: true,
      }),
    );
    expect(action).toEqual(recoveryForNarration(true, "plan_open"));
  });

  it("does not treat a post-mutation summary as an unapplied fix", () => {
    const action = chooseFinalizeRecovery(
      narrating({
        cleaned: ERROR_FIX_TEXT,
        sawSuccessfulMutation: true,
        planApproved: true,
        planHasOpenWork: true,
      }),
    );
    expect(action).toEqual(recoveryForNarration(true, "plan_open"));
  });

  it("orders the narration modes plan_open > pentest > web > build_plan_prose > build > generic", () => {
    expect(
      chooseFinalizeRecovery(
        narrating({
          planApproved: true,
          planHasOpenWork: true,
          pentestLikeTurn: true,
          buildLikeTurn: true,
          }),
      ),
    ).toEqual(recoveryForNarration(true, "plan_open"));

    expect(
      chooseFinalizeRecovery(
        narrating({
          pentestLikeTurn: true,
          buildLikeTurn: true,
          }),
      ),
    ).toEqual(recoveryForNarration(true, "pentest"));

    expect(
      chooseFinalizeRecovery(
        narrating({ buildLikeTurn: true, narratedWebAction: true }),
      ),
    ).toEqual(recoveryForNarration(true, "web"));

    expect(
      chooseFinalizeRecovery(
        narrating({ buildLikeTurn: true, productiveSteps: 2, narratedAction: true }),
      ),
    ).toEqual(recoveryForNarration(true, "build_plan_prose"));

    expect(chooseFinalizeRecovery(narrating({ buildLikeTurn: true }))).toEqual(
      recoveryForNarration(true, "build"),
    );

    expect(chooseFinalizeRecovery(narrating())).toEqual(
      recoveryForNarration(true, "generic"),
    );
  });

  it("skips the whole family when the turn does not want action", () => {
    expect(
      chooseFinalizeRecovery(
        narrating({ wantsAction: false, buildLikeTurn: true }),
      ),
    ).toBeUndefined();
  });

  it("skips the whole family when the cleaned text is blank", () => {
    expect(
      chooseFinalizeRecovery(narrating({ cleaned: "   ", buildLikeTurn: true })),
    ).toBeUndefined();
  });
});

describe("finalize gate — missing plan", () => {
  const planModeInput = (overrides: Partial<FinalizeGateInput> = {}) =>
    baseInput({ isPlanMode: true, ...overrides });

  it("fires in plan mode when no plan exists", () => {
    expect(chooseFinalizeRecovery(planModeInput())?.kind).toBe("force_plan");
  });

  it("does not fire once plan.create succeeded", () => {
    expect(
      chooseFinalizeRecovery(planModeInput({ sawPlanCreateOk: true })),
    ).toBeUndefined();
  });

  it("does not fire when a plan is already live", () => {
    expect(
      chooseFinalizeRecovery(
        planModeInput({ plan: planWith([{ id: "t1", title: "a", state: "done" }]) }),
      ),
    ).toBeUndefined();
  });

  it("still fires when only web narration is present", () => {
    expect(
      chooseFinalizeRecovery(planModeInput({ narratedWebAction: true }))?.kind,
    ).toBe("force_plan");
  });
});

describe("finalize gate — missing feature", () => {
  const featureInput = (overrides: Partial<FinalizeGateInput> = {}) =>
    baseInput({
      buildLike: true,
      planApproved: true,
      featureAppAsk: true,
      sawScaffoldOk: true,
      productiveSteps: 2,
      projectRoot: "/tmp/app",
      ...overrides,
    });

  it("fires when only a scaffold landed", () => {
    const action = chooseFinalizeRecovery(featureInput());
    expect(action?.kind).toBe("feature_impl");
    expect(action?.message).toContain("/tmp/app");
  });

  it("does not fire once the feature was written", () => {
    expect(
      chooseFinalizeRecovery(featureInput({ sawFeatureImplWrite: true }))?.kind,
    ).not.toBe("feature_impl");
  });

  it("does not fire for a pentest turn or session", () => {
    expect(
      chooseFinalizeRecovery(featureInput({ pentestLike: true }))?.kind,
    ).not.toBe("feature_impl");
    expect(
      chooseFinalizeRecovery(featureInput({ pentestSession: true }))?.kind,
    ).not.toBe("feature_impl");
  });

  it("does not fire without productive steps", () => {
    expect(
      chooseFinalizeRecovery(
        featureInput({ productiveSteps: 0, wantsAction: false }),
      ),
    ).toBeUndefined();
  });

  it("loses to missing plan and wins once forcePlan is spent", () => {
    expect(
      chooseFinalizeRecovery(featureInput({ isPlanMode: true }))?.kind,
    ).toBe("force_plan");
    expect(
      chooseFinalizeRecovery(
        featureInput({ isPlanMode: true, recovery: drained("forcePlan", 2) }),
      )?.kind,
    ).toBe("feature_impl");
  });

  it("loses to nothing before the failed probe and yields to it when spent", () => {
    const probing = {
      sawFailedLocalHttpProbe: true,
      sawLocalHttpProbe: false,
    } as const;
    expect(chooseFinalizeRecovery(featureInput(probing))?.kind).toBe(
      "feature_impl",
    );
    expect(
      chooseFinalizeRecovery(
        featureInput({ ...probing, recovery: drained("featureImpl", 2) }),
      )?.kind,
    ).toBe("failed_probe");
  });
});

describe("finalize gate — runtime verify", () => {
  const finishedCodingPlan = planWith([
    { id: "t1", title: "scaffold", state: "done" },
    { id: "t2", title: "implement", state: "skipped" },
  ]);
  const runtimeInput = (overrides: Partial<FinalizeGateInput> = {}) =>
    baseInput({
      buildLike: true,
      planApproved: true,
      plan: finishedCodingPlan,
      projectRoot: "/tmp/app",
      ...overrides,
    });

  it("fires when a finished coding plan has no runtime proof and the outcome contract requires a server", () => {
    const action = chooseFinalizeRecovery(
      runtimeInput({ serverCriterionRequired: true }),
    );
    expect(action?.kind).toBe("runtime_verify");
    expect(action?.message).toContain("/tmp/app");
  });

  it("does not fire for a finished coding plan whose outcome contract has no server criterion", () => {
    expect(chooseFinalizeRecovery(runtimeInput())).toBeUndefined();
  });

  it("does not fire when the plan carries runtime evidence", () => {
    expect(
      chooseFinalizeRecovery(
        runtimeInput({
          plan: planWith(finishedCodingPlan.tasks, { hasVerifiedRuntime: true }),
        }),
      ),
    ).toBeUndefined();
  });

  it("does not fire when this turn started a server and tailed it", () => {
    expect(
      chooseFinalizeRecovery(
        runtimeInput({ sawServerStart: true, sawServerTail: true }),
      ),
    ).toBeUndefined();
  });

  it("does not fire when a feature app ask is still unimplemented", () => {
    expect(
      chooseFinalizeRecovery(
        runtimeInput({ featureAppAsk: true, sawFeatureImplWrite: false }),
      ),
    ).toBeUndefined();
  });

  it("fires for a freestyle local app that only tells the user how to run it", () => {
    expect(
      chooseFinalizeRecovery(
        runtimeInput({
          planApproved: false,
          plan: undefined,
          sawLocalAppMaterialWork: true,
          productiveSteps: 2,
          serverCriterionRequired: true,
          cleaned: "The app is ready. Run npm run dev to start it.",
        }),
      )?.kind,
    ).toBe("runtime_verify");
  });

  it("yields to the failed probe once its budget is spent", () => {
    const probing = {
      sawFailedLocalHttpProbe: true,
      sawLocalHttpProbe: false,
      serverCriterionRequired: true,
    } as const;
    expect(chooseFinalizeRecovery(runtimeInput(probing))?.kind).toBe(
      "runtime_verify",
    );
    expect(
      chooseFinalizeRecovery(
        runtimeInput({ ...probing, recovery: drained("runtimeVerify", 2) }),
      )?.kind,
    ).toBe("failed_probe");
  });
});

describe("finalize gate — failed probe", () => {
  const probeInput = (overrides: Partial<FinalizeGateInput> = {}) =>
    baseInput({
      buildLike: true,
      sawFailedLocalHttpProbe: true,
      plan: planWith([{ id: "t1", title: "build", state: "done" }], {
        hasVerifiedRuntime: true,
      }),
      ...overrides,
    });

  it("fires on a failed localhost probe with no later success", () => {
    expect(chooseFinalizeRecovery(probeInput())?.kind).toBe("failed_probe");
  });

  it("does not fire once a probe succeeded", () => {
    expect(
      chooseFinalizeRecovery(probeInput({ sawLocalHttpProbe: true })),
    ).toBeUndefined();
  });

  it("does not fire on blank text", () => {
    expect(chooseFinalizeRecovery(probeInput({ cleaned: "  " }))).toBeUndefined();
  });

  it("lets the turn finalize once its budget is spent", () => {
    const unfinished = {
      planApproved: true,
      plan: planWith(
        [
          { id: "t1", title: "build", state: "done" },
          { id: "t2", title: "verify", state: "pending" },
        ],
        { hasVerifiedRuntime: true },
      ),
    };
    expect(chooseFinalizeRecovery(probeInput(unfinished))?.kind).toBe(
      "failed_probe",
    );
    expect(
      chooseFinalizeRecovery(
        probeInput({ ...unfinished, recovery: drained("failedProbe", 3) }),
      ),
    ).toBeUndefined();
  });
});

describe("finalize gate — shallow pentest", () => {
  const pentestInput = (overrides: Partial<FinalizeGateInput> = {}) =>
    baseInput({
      pentestLike: true,
      productiveSteps: 5,
      cleaned: SHALLOW_PENTEST_TEXT,
      ...overrides,
    });

  it("fires on a ports-only write-up", () => {
    expect(chooseFinalizeRecovery(pentestInput())?.kind).toBe("shallow_pentest");
  });

  it("does not fire once a real test ran", () => {
    expect(
      chooseFinalizeRecovery(pentestInput({ sawActivePentestTest: true })),
    ).toBeUndefined();
  });

  it("lets the turn finalize once its budget is spent", () => {
    const unfinished = {
      planApproved: true,
      plan: planWith(
        [
          { id: "t1", title: "recon", state: "done" },
          { id: "t2", title: "test auth", state: "in_progress" },
        ],
        { kind: "pentest" },
      ),
    };
    expect(chooseFinalizeRecovery(pentestInput(unfinished))?.kind).toBe(
      "shallow_pentest",
    );
    expect(
      chooseFinalizeRecovery(
        pentestInput({ ...unfinished, recovery: drained("shallowPentest", 2) }),
      ),
    ).toBeUndefined();
  });
});

describe("finalize gate — unfinished approved plan", () => {
  const unfinishedPlan = planWith([
    { id: "t1", title: "scaffold", state: "done" },
    { id: "t2", title: "implement", state: "pending" },
  ]);

  it("lets the agent stop with unfinished tasks instead of forcing continuation", () => {
    expect(
      chooseFinalizeRecovery(
        baseInput({ planApproved: true, plan: unfinishedPlan }),
      ),
    ).toBeUndefined();
  });

  it("lets an in-progress task stay open when the agent stops", () => {
    expect(
      chooseFinalizeRecovery(
        baseInput({
          planApproved: true,
          plan: planWith([
            { id: "t1", title: "scaffold", state: "done" },
            { id: "t2", title: "add architecture guard", state: "in_progress" },
          ]),
          sawFeatureImplWrite: true,
          sawSuccessfulMutation: true,
          productiveSteps: 3,
        }),
      ),
    ).toBeUndefined();
  });
});
