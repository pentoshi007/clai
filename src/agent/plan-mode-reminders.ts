
export const PLAN_REMINDER_FIRST_STEP = 15;
export const PLAN_REMINDER_STEP_INTERVAL = 10;

export const PLAN_REMINDER_TOAST = "reminder sent · plan mode";

export interface PlanReminderGate {
  readonly isPlanMode: boolean;
  readonly planApproved: boolean;
  readonly hasDraftPlan: boolean;
  readonly productiveStep: number;
  readonly alreadyRemindedAt: ReadonlySet<number>;
}

export function isPlanReminderMilestone(step: number): boolean {
  if (!Number.isFinite(step) || step < PLAN_REMINDER_FIRST_STEP) return false;
  return (step - PLAN_REMINDER_FIRST_STEP) % PLAN_REMINDER_STEP_INTERVAL === 0;
}

export function shouldAttachPlanModeReminder(opts: PlanReminderGate): boolean {
  if (!opts.isPlanMode) return false;
  if (opts.planApproved) return false;
  if (opts.hasDraftPlan) return false;
  if (!isPlanReminderMilestone(opts.productiveStep)) return false;
  if (opts.alreadyRemindedAt.has(opts.productiveStep)) return false;
  return true;
}

export interface PlanReminderTextOpts {
  readonly step: number;
  readonly kindHint?: "pentest" | "coding" | "general" | undefined;
}

export function planModeResearchReminder(opts: PlanReminderTextOpts): string {
  const step = Math.max(0, Math.floor(opts.step));
  const domain =
    opts.kindHint === "pentest"
      ? "context, attack surface, stack/fingerprint, and juicy findings"
      : opts.kindHint === "coding"
        ? "workspace/stack context, constraints, and architecture facts"
        : "context and discovery that will improve the plan";

  return (
    `\n\n[plan-mode reminder · step ${step}] ` +
    `This is a calibration note, not a stop order or a demand to keep collecting data. ` +
    `Reconcile what you know against the requested outcome, material ${domain}, and the decisions the plan must make. ` +
    `Continue research where an unresolved uncertainty could change scope, architecture, priority, safety, or verification; avoid repeating low-yield work once those decisions are supported. ` +
    `Represent important unresolved or untested surfaces explicitly in the plan rather than hiding them or researching forever. ` +
    `When material coverage is mapped and plan-changing uncertainty is resolved, deliver one comprehensive plan.create with evidence, assumptions, risks, ordered outcome tasks, branch conditions, and verification, then await acceptance.`
  );
}

export function maybeAppendPlanModeReminder(
  toolContent: string,
  opts: PlanReminderGate & PlanReminderTextOpts,
): { content: string; reminded: boolean } {
  if (!shouldAttachPlanModeReminder(opts)) {
    return { content: toolContent, reminded: false };
  }
  const note = planModeResearchReminder({
    step: opts.productiveStep,
    kindHint: opts.kindHint,
  });
  return { content: toolContent + note, reminded: true };
}
