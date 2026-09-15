export function buildPlanRevisionPrompt(
  feedback: string,
  opts?: { planVersion?: number | undefined },
): string {
  const version = opts?.planVersion ?? 1;
  const text = feedback.trim();
  return (
    `Plan revision request from the user (plan mode). Current plan version: ${version}. ` +
    "This is still a DRAFT awaiting accept — rewrite decisively. " +
    "The revised plan must remain self-contained after approval and context compaction: preserve verified evidence, exact files or target assets, contracts or trust boundaries, assumptions, non-goals, branch decisions, risks, and verification evidence in the detail. " +
    "Emit ONE plan.create with the COMPLETE intended goal, durable detail, and ordered tasks (full checklist, not a partial delta). " +
    "Every task must be a distinct outcome with affected surface, dependencies, and observable acceptanceCriteria; include error, rollback, integration, regression, runtime or impact proof as applicable. " +
    "For pentest work retain scope, authorization/ROE, attack-surface ledger, identities, hypotheses, safe PoC/impact validation, cleanup, reporting, and residual untested coverage. " +
    "For software work retain repository paths, contracts/data flow, implementation boundaries, migrations, edge states, tests, and runtime/deployment proof. " +
    "Omit obsolete tasks entirely (e.g. drop Prisma/JWT/API when the user wants frontend-only). " +
    "Reuse a prior task title only when that step still has the same intent (so ids can stay stable); otherwise use a clear new title. " +
    "Pick one coherent interpretation of the feedback and apply it — do not monologue long chains of alternatives. " +
    "If a foundational choice is truly ambiguous, ask ONE short clarifying question instead of plan.create. " +
    "Do not implement yet. After plan.create, STOP for accept / suggest / discard. " +
    `User feedback:\n${text}`
  );
}

export function shouldBlockPlanModeMutate(
  isPlanMode: boolean,
  planApproved: boolean,
): boolean {
  return isPlanMode && !planApproved;
}
