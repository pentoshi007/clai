export interface DeferrableBoundCall {
  readonly call: { readonly name: string };
}

export interface PlanCallDeferral {
  readonly runCount: number;
  readonly deferReason: string;
  readonly notice: string | undefined;
  readonly systemMessage: string | undefined;
}

const DEFAULT_DEFER_REASON =
  "Cancelled — not executed this turn (deferred or omitted).";

export const decidePlanCallDeferral = (
  bound: readonly DeferrableBoundCall[],
): PlanCallDeferral => {
  const planIndex = bound.findIndex(
    (entry) => entry.call.name === "plan.create",
  );
  if (planIndex > 0) {
    const deferredCount = bound.length - planIndex;
    return {
      runCount: planIndex,
      deferReason:
        "Deferred — plan.create must wait until reconnaissance results exist.",
      notice:
        "deferring plan.create until reconnaissance results are available",
      systemMessage:
        `The prior response included plan.create before its reconnaissance results existed. ` +
        `Only the ${planIndex} gathering call(s) before it were run; ${deferredCount} plan/follow-on call(s) were not run. ` +
        "Now analyse the tool results. If a plan is appropriate, emit exactly one standalone plan.create tool call based only on those results. Do not include any other tool calls in that response.",
    };
  }
  if (planIndex === 0 && bound.length > 1) {
    const deferredCount = bound.length - 1;
    return {
      runCount: 1,
      deferReason:
        "Deferred — waiting for plan approval before follow-on tools.",
      notice:
        "creating the plan now; deferring follow-on calls until it is approved",
      systemMessage:
        `You emitted plan.create alongside ${deferredCount} follow-on call(s). Only plan.create was run; ` +
        `the follow-on call(s) were not. Wait for the plan to be reviewed, then proceed task by task.`,
    };
  }
  return {
    runCount: bound.length,
    deferReason: DEFAULT_DEFER_REASON,
    notice: undefined,
    systemMessage: undefined,
  };
};
