/**
 * Completion-time recovery decisions: when a tool-free (or incomplete)
 * final answer must be rejected and the agent forced to act.
 */

export interface RecoveryBudgets {
  actionIntent: number;
  errorFix: number;
  forcePlan: number;
  featureImpl: number;
  failedProbe: number;
  shallowPentest: number;
}

export function createRecoveryBudgets(): RecoveryBudgets {
  return {
    actionIntent: 0,
    errorFix: 0,
    forcePlan: 0,
    featureImpl: 0,
    failedProbe: 0,
    shallowPentest: 0,
  };
}

export type RecoveryKind =
  | "error_fix"
  | "narration"
  | "force_plan"
  | "feature_impl"
  | "failed_probe"
  | "shallow_pentest";

export interface RecoveryAction {
  kind: RecoveryKind;
  /** User/model-facing instruction to append. */
  message: string;
  /** Short terminal notice. */
  notice: string;
  budgetKey: keyof RecoveryBudgets;
}

const LIMITS: Record<keyof RecoveryBudgets, number> = {
  actionIntent: 3,
  errorFix: 3,
  forcePlan: 2,
  featureImpl: 2,
  failedProbe: 3,
  shallowPentest: 2,
};

export function budgetRemaining(
  budgets: RecoveryBudgets,
  key: keyof RecoveryBudgets,
): boolean {
  return budgets[key] < LIMITS[key];
}

export function consumeBudget(
  budgets: RecoveryBudgets,
  key: keyof RecoveryBudgets,
): void {
  budgets[key] = budgets[key] + 1;
}

export function recoveryForErrorDiagnosis(nativeTools: boolean): RecoveryAction {
  return {
    kind: "error_fix",
    budgetKey: "errorFix",
    notice: "error diagnosed but not fixed — forcing tool call",
    message: nativeTools
      ? "You diagnosed an error and described the fix but called NO tool. " +
        "Apply the fix now (fs.edit / fs.write / shell.exec), then re-verify. " +
        "Do not stop after identifying the error."
      : "You diagnosed an error and described the fix but emitted NO tool call. " +
        "Apply the fix now, e.g.:\n" +
        '```tool\n{"name":"fs.edit","args":{"path":"<file>","oldText":"...","newText":"..."}}\n```\n' +
        "Then re-run the failing check.",
  };
}

const INTENT_ESCAPE =
  " Before doing that, re-read the user's latest message. This nudge fires from a keyword guess about their wording and can be wrong: if they were asking a question, raising a doubt, or asking you to explain, review, compare, or advise, then an answer with no changes was the correct deliverable — say so in one line and finish, without calling a tool and without starting work they did not ask for.";

export function recoveryForNarration(
  nativeTools: boolean,
  mode: "plan_open" | "pentest" | "web" | "build_plan_prose" | "build" | "generic",
): RecoveryAction {
  const base = {
    kind: "narration" as const,
    budgetKey: "actionIntent" as const,
    notice: "described an action but emitted no tool call",
  };
  if (mode === "plan_open") {
    return {
      ...base,
      message: nativeTools
        ? "You wrote a message but called NO tool. Call the next tool now (task.update / fs.write / shell.exec)."
        : "You wrote a message but emitted NO ```tool block. Emit the next tool call now.",
    };
  }
  if (mode === "pentest") {
    return {
      ...base,
      notice: "described a security action but emitted no tool call",
      message:
        (nativeTools
          ? "You described security work but called NO tool. Call a real tool now (net.scan / http.fetch / dns.lookup / shell.exec)."
          : "You described security work but emitted NO ```tool block. Emit a real tool call now (e.g. sysinfo, net.scan, http.fetch).") +
        INTENT_ESCAPE,
    };
  }
  if (mode === "web") {
    return {
      ...base,
      notice: "described a web action but emitted no tool call",
      message: nativeTools
        ? "You claimed a search/fetch but called NO tool. Call web.search or web.fetch now, then answer from results."
        : "You claimed a search/fetch but emitted NO ```tool block. Emit web.search or web.fetch now.",
    };
  }
  if (mode === "build_plan_prose") {
    return {
      ...base,
      notice: "plan was written as text, not created",
      message:
        (nativeTools
          ? 'You wrote the plan as prose but did NOT call plan.create. Call plan.create now with goal, detail, tasks, and a specific kind you choose to fit the work (e.g. build, frontend, feature, bugfix, pentest, recon — not "general").'
          : "You wrote the plan as prose but did NOT call plan.create. Emit one plan.create tool block now.") +
        " If the user only asked how you would approach something rather than telling you to do it, the prose answer was correct — say so in one line and finish instead of creating a plan.",
    };
  }
  if (mode === "build") {
    return {
      ...base,
      message:
        (nativeTools
          ? 'You described work but called NO tool. Call a tool now (e.g. fs.list path="."), then plan.create when ready.'
          : "You described work but emitted NO ```tool block. Explore first, then plan.create when ready.") +
        INTENT_ESCAPE,
    };
  }
  return {
    ...base,
    message:
      (nativeTools
        ? "You described an action but called NO tool. Call the appropriate tool now."
        : "You described an action but emitted NO ```tool block. Emit a real tool call now.") +
      INTENT_ESCAPE,
  };
}

/** Plan mode only — agent mode must not force plan.create. */
export function recoveryForMissingPlan(nativeTools: boolean): RecoveryAction {
  return {
    kind: "force_plan",
    budgetKey: "forcePlan",
    notice: "plan mode missing plan.create",
    message: nativeTools
      ? "You are in plan mode and tried to finish without a durable plan. Gather any remaining context you need, then call plan.create " +
        "(goal, rich detail with context/approach/risks/verify, all relevant tasks — no artificial cap, kind=coding|pentest|general as appropriate). Do not implement yet."
      : "You are in plan mode and tried to finish without a durable plan. Gather context if needed, then emit plan.create with a comprehensive plan (any relevant task count). Do not implement yet.",
  };
}

export function recoveryForMissingFeature(projectRoot?: string): RecoveryAction {
  const rootHint = projectRoot
    ? ` Write under "${projectRoot}" with absolute paths.`
    : "";
  return {
    kind: "feature_impl",
    budgetKey: "featureImpl",
    notice: "feature not implemented — scaffold alone is incomplete",
    message:
      "INCOMPLETE: the user asked for a working product feature, not a blank framework starter. " +
      "Scaffold alone is a failure. Implement the requested feature now (replace starter boilerplate) " +
      "with fs.write / fs.writeMany. Do not shell.start until that feature exists." +
      rootHint,
  };
}


export function recoveryForFailedProbe(): RecoveryAction {
  return {
    kind: "failed_probe",
    budgetKey: "failedProbe",
    notice: "localhost probe failed — fix and re-verify",
    message:
      "The local HTTP probe failed (4xx/5xx or connection refused). Do not stop. " +
      "Diagnose from the error, apply a real fix with fs.edit/fs.write, re-probe, and only then mark verify done. " +
      "Identifying the error without a tool call is incomplete.",
  };
}

/** True when a final pentest write-up looks like skim recon without real coverage. */
export function looksLikeShallowPentestReport(
  text: string,
  opts: { productiveSteps: number; sawActiveTest: boolean },
): boolean {
  if (opts.sawActiveTest) return false;
  if (opts.productiveSteps < 3) return false;
  const t = text.trim();
  if (t.length < 80) return false;
  const lower = t.toLowerCase();
  if (!/\b(finding|vulnerab|assessment|report|recon|open port|security posture|risk rating)\b/.test(lower)) {
    return false;
  }
  const deep =
    /\b(idor|broken access|injection|xss|csrf|ssrf|rce|sqli|auth.?bypass|privilege|jwt|poc|exploit|confirmed|reproduc|ffuf|gobuster|ferox|directory enum|content discovery|crt\.sh|certificate transparency)\b/i.test(
      t,
    );
  if (deep) return false;
  const shallow =
    /\b(open ports?|port\s+\d+|server header|missing (?:security )?header|http\/1|tls|banner|robots\.txt|top[- ]?ports?|mature (?:security )?posture|overall risk rating:\s*low)\b/i.test(
      t,
    );
  const claimsComplete =
    /\b(no critical|no high|mature|strong security posture|not vulnerable)\b/i.test(
      t,
    ) &&
    !/\b(untested|residual|not (?:tested|enumerated|scanned)|limited scope)\b/i.test(
      t,
    );
  return shallow || claimsComplete;
}

export function recoveryForShallowPentest(): RecoveryAction {
  return {
    kind: "shallow_pentest",
    budgetKey: "shallowPentest",
    notice: "pentest conclusion is not supported by enough evidence",
    message:
      "The current conclusion is stronger than the evidence. Reassess the engagement objective, observed surface, likely impact, material unknowns, and threat model. " +
      "Choose the next highest-value in-scope test yourself; do not follow a fixed enumeration or scanner checklist, and do not repeat work that already produced usable evidence. " +
      "Continue while a safe action can materially improve confidence. Otherwise report the limitation and residual or untested risk honestly instead of claiming a mature posture.",
  };
}

