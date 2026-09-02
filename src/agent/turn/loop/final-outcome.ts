import type { SessionPlan } from "../../../store/plan.js";
import type { TurnOutcomeStatus } from "../../turn-outcome.js";
import type { OutcomeEnvelope } from "../../outcomes.js";
import {
  deriveOutcomeStatus,
  recordAnswerEvidence,
  validateCriterionEvidence,
} from "../../outcomes.js";
import { foregroundRemaining, responderOpenTasks } from "../../../store/plan.js";

export interface FinalOutcomePorts {
  readonly outcomeState: OutcomeEnvelope;
  readonly planApproved: boolean;
  readonly loadPlan: () => Promise<SessionPlan | undefined>;
  readonly saveOutcomeState: (state: OutcomeEnvelope) => Promise<void>;
}

export interface FinalOutcome {
  readonly status: TurnOutcomeStatus;
  readonly remainingCriteria: string[];
  readonly reason: string | undefined;
}

const planRemainingCriteria = (
  plan: SessionPlan | undefined,
): { criteria: string[]; status: TurnOutcomeStatus | undefined } => {
  if (!plan) return { criteria: [], status: undefined };
  const unfinished = foregroundRemaining(plan);
  const failed = plan.tasks.filter(
    (task) => !task.responderOwned && task.state === "failed",
  );
  const criteria = [
    ...unfinished.map((task) => `[${task.id}] ${task.title}`),
    ...failed.map((task) => `[${task.id}] retry failed task: ${task.title}`),
    ...responderOpenTasks(plan).map(
      (task) => `[${task.id}] responder result awaiting analysis: ${task.title}`,
    ),
  ];
  if (failed.length > 0) return { criteria, status: "failed" };
  if (unfinished.length > 0) return { criteria, status: "partial" };
  return { criteria, status: undefined };
};

const reasonFor = (status: TurnOutcomeStatus): string | undefined => {
  if (status === "failed") return "One or more required plan tasks failed.";
  if (status === "partial") {
    return "Required outcome criteria remain unsupported by current evidence.";
  }
  return undefined;
};

export const resolveFinalOutcome = async (
  ports: FinalOutcomePorts,
  answer: string,
): Promise<FinalOutcome> => {
  let status: TurnOutcomeStatus = "succeeded";
  const remainingCriteria: string[] = [];
  if (ports.planApproved) {
    const plan = await ports.loadPlan();
    const fromPlan = planRemainingCriteria(plan);
    remainingCriteria.push(...fromPlan.criteria);
    if (fromPlan.status) status = fromPlan.status;
  }

  recordAnswerEvidence(ports.outcomeState, answer);
  ports.outcomeState.outcome.status = deriveOutcomeStatus(
    ports.outcomeState.outcome,
    ports.outcomeState.evidence,
  );
  await ports.saveOutcomeState(ports.outcomeState);

  const unsupported = ports.outcomeState.outcome.criteria.filter(
    (criterion) =>
      criterion.required &&
      !validateCriterionEvidence(criterion, ports.outcomeState.evidence).ok,
  );
  if (unsupported.length > 0 && status === "succeeded") status = "partial";
  remainingCriteria.push(
    ...unsupported
      .map((criterion) => criterion.statement)
      .filter((statement) => !remainingCriteria.includes(statement)),
  );

  return { status, remainingCriteria, reason: reasonFor(status) };
};
