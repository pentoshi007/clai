import type { ChatMessage } from "../../../types.js";
import type { SessionPlan } from "../../../store/plan.js";
import type { OutcomeEnvelope } from "../../outcomes.js";
import {
  inferOutcomeKind,
  openOutcomeState,
  saveOutcomeState,
} from "../../outcomes.js";
import { analyzeTask } from "../../task-analyzer.js";
import { isPlanTerminal } from "../../../store/plan.js";
import {
  computeMaxIterations,
  computeStepBudget,
} from "../../step-budget.js";

const CONTINUE_INTENT =
  /^(?:continue|resume|proceed|keep\s+going|finish|next)\b/i;

export interface TurnBudget {
  readonly analysis: ReturnType<typeof analyzeTask>;
  readonly maxIterations: number;
  readonly outcomeState: OutcomeEnvelope;
}

export const openTurnBudget = async (input: {
  readonly prompt: string;
  readonly sessionId: string;
  readonly plan: SessionPlan | undefined;
  readonly history: ChatMessage[] | undefined;
  readonly maxSteps: number;
  readonly buildLike: boolean;
  readonly pentestLike: boolean;
  readonly restoreCompletedOperations: (
    operations: OutcomeEnvelope["completedOperations"],
  ) => void;
}): Promise<TurnBudget> => {
  const analysis = analyzeTask(input.prompt);
  const outcomeState = await openOutcomeState({
    sessionId: input.sessionId,
    userIntent: input.prompt,
    kind: inferOutcomeKind({
      userIntent: input.prompt,
      buildLike: input.buildLike,
      pentestLike: input.pentestLike,
    }),
    continueExisting:
      CONTINUE_INTENT.test(input.prompt.trim()) ||
      Boolean(input.plan && !isPlanTerminal(input.plan)),
  });
  input.restoreCompletedOperations(outcomeState.completedOperations ?? []);
  await saveOutcomeState(outcomeState);
  const stepBudget = computeStepBudget({
    analysis,
    maxSteps: input.maxSteps,
    buildLike: input.buildLike,
    pentestLike: input.pentestLike,
    hasHistory: (input.history?.length ?? 0) > 0,
  });
  return {
    analysis,
    // Iteration count is only an emergency protection for recovery/model loops;
    // normal continuation is governed by evidence and resource deltas.
    maxIterations: Math.max(210, computeMaxIterations(stepBudget)),
    outcomeState,
  };
};
