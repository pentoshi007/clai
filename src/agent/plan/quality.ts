import type { NormalizedPlanTask } from "./normalization.js";

export const PLAN_DETAIL_MIN_CHARS = 280;

export interface PlanDraftProposal {
  readonly detail: string;
  readonly entries: readonly NormalizedPlanTask[];
}

const taskList = (positions: readonly number[]): string =>
  positions.map((position) => `#${position}`).join(", ");

const missing = (
  entries: readonly NormalizedPlanTask[],
  lacks: (entry: NormalizedPlanTask) => boolean,
): number[] =>
  entries.flatMap((entry, index) => (lacks(entry) ? [index + 1] : []));

export function planDraftGaps(proposal: PlanDraftProposal): string[] {
  const gaps: string[] = [];
  const detailChars = proposal.detail.trim().length;
  if (detailChars < PLAN_DETAIL_MIN_CHARS) {
    gaps.push(
      `detail has ${detailChars} characters; write the durable brief (scope and non-goals, verified evidence, affected files or assets, decisions, risks, validation)`,
    );
  }
  const withoutSteps = missing(proposal.entries, (entry) => entry.steps.length === 0);
  if (withoutSteps.length > 0) {
    gaps.push(
      `tasks ${taskList(withoutSteps)} need steps naming the files, symbols or assets, the concrete change or test, and the check to run`,
    );
  }
  const withoutAcceptance = missing(proposal.entries, (entry) => !entry.acceptanceCriteria);
  if (withoutAcceptance.length > 0) {
    gaps.push(
      `tasks ${taskList(withoutAcceptance)} need observable acceptanceCriteria`,
    );
  }
  return gaps;
}
