import type { PlanStatus, SessionPlan } from "../../../store/plan.js";
import {
  collapseRepeatedText,
  looksLikeActionNarration,
  looksLikeWebActionNarration,
  stripSentinelTokens,
} from "../../tool-call-parser.js";
import { planHasOpenWork } from "../../session-policy.js";

export interface CompletionAssessmentInput {
  readonly visible: string;
  readonly canonicalVisible: string;
  readonly livePlan: SessionPlan | undefined;
  readonly activePlanStatus: PlanStatus | undefined;
  readonly planApproved: boolean;
  readonly informationalQuery: boolean;
  readonly idleOrSocialPrompt: boolean;
  readonly buildLikeTurn: boolean;
  readonly pentestLikeTurn: boolean;
}

export interface CompletionAssessment {
  readonly displayCleaned: string;
  readonly cleaned: string;
  readonly narratedAction: boolean;
  readonly narratedWebAction: boolean;
  readonly planHasOpenWorkNow: boolean;
  readonly completedPlanDuringThisTurn: boolean;
  readonly wantsAction: boolean;
}

export const assessCompletion = (
  input: CompletionAssessmentInput,
): CompletionAssessment => {
  const displayCleaned = collapseRepeatedText(
    stripSentinelTokens(input.visible),
  );
  const cleaned = collapseRepeatedText(
    stripSentinelTokens(input.canonicalVisible),
  );
  const narratedAction = looksLikeActionNarration(cleaned);
  const narratedWebAction = looksLikeWebActionNarration(cleaned);
  const planStatus = input.livePlan?.status ?? input.activePlanStatus;
  const completedPlanDuringThisTurn =
    input.activePlanStatus !== "completed" && planStatus === "completed";
  const planHasOpenWorkNow = planHasOpenWork(planStatus);
  const userExpectsWork =
    (planHasOpenWorkNow && input.planApproved) ||
    (!input.informationalQuery &&
      !input.idleOrSocialPrompt &&
      (input.buildLikeTurn || input.pentestLikeTurn));
  const wantsAction =
    !completedPlanDuringThisTurn &&
    !input.idleOrSocialPrompt &&
    (userExpectsWork ||
      (narratedAction && !input.informationalQuery) ||
      (narratedWebAction && !input.informationalQuery));
  return {
    displayCleaned,
    cleaned,
    narratedAction,
    narratedWebAction,
    planHasOpenWorkNow,
    completedPlanDuringThisTurn,
    wantsAction,
  };
};

