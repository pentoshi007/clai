export function buildPlanRevisionPrompt(
  feedback: string,
  opts?: { planVersion?: number | undefined },
): string {
  const version = opts?.planVersion ?? 1;
  const text = feedback.trim();
  return (
    `Plan revision request from the user (plan mode). Current plan version: ${version}. ` +
    "This is still a DRAFT awaiting accept — rewrite decisively. " +
    "Emit ONE plan.create with the COMPLETE intended goal, detail, and ordered tasks (full checklist, not a partial delta). " +
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
