import type { PlanStatus, SessionPlan } from "../../../store/plan.js";
import type { FinalizeGateInput } from "../../finalize-gate.js";
import type { RecoveryBudgets } from "../../must-continue.js";
import type { TurnEvidenceFlags } from "../evidence-flags.js";
import {
  collapseRepeatedText,
  looksLikeActionNarration,
  looksLikeWebActionNarration,
  stripSentinelTokens,
} from "../../tool-call-parser.js";
import { planHasOpenWork } from "../../session-policy.js";
import { planHasVerifiedRuntime } from "../task-gate.js";

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

export interface FinalizeGateContext {
  readonly assessment: CompletionAssessment;
  readonly recovery: RecoveryBudgets;
  readonly evidenceFlags: TurnEvidenceFlags;
  readonly livePlan: SessionPlan | undefined;
  readonly toolsAttached: boolean;
  readonly productiveSteps: number;
  readonly planApproved: boolean;
  readonly activePlanExists: boolean;
  readonly isPlanMode: boolean;
  readonly buildLikeTurn: boolean;
  readonly pentestLikeTurn: boolean;
  readonly buildLike: boolean;
  readonly pentestLike: boolean;
  readonly pentestSession: boolean;
  readonly informationalQuery: boolean;
  readonly idleOrSocialPrompt: boolean;
  readonly featureAppAsk: boolean;
  readonly projectRoot: string | undefined;
  readonly deferResponderReport: boolean;
}

export const buildFinalizeGateInput = (
  context: FinalizeGateContext,
): FinalizeGateInput => {
  const { assessment: a, evidenceFlags: f, livePlan } = context;
  return {
    cleaned: a.cleaned,
    recovery: context.recovery,
    toolsAttached: context.toolsAttached,
    productiveSteps: context.productiveSteps,
    planApproved: context.planApproved,
    planHasOpenWork: a.planHasOpenWorkNow,
    activePlanExists: context.activePlanExists,
    wantsAction: a.wantsAction,
    narratedAction: a.narratedAction,
    narratedWebAction: a.narratedWebAction,
    isPlanMode: context.isPlanMode,
    buildLikeTurn: context.buildLikeTurn,
    pentestLikeTurn: context.pentestLikeTurn,
    buildLike: context.buildLike,
    pentestLike: context.pentestLike,
    pentestSession: context.pentestSession,
    informationalQuery: context.informationalQuery,
    idleOrSocialPrompt: context.idleOrSocialPrompt,
    sawPlanCreateOk: f.sawPlanCreateOk,
    sawFeatureImplWrite: f.sawFeatureImplWrite,
    sawScaffoldOk: f.sawScaffoldOk,
    sawLocalAppMaterialWork: f.sawLocalAppMaterialWork,
    sawServerStart: f.sawServerStart,
    sawServerTail: f.sawServerTail,
    sawLocalHttpProbe: f.sawLocalHttpProbe,
    sawFailedLocalHttpProbe: f.sawFailedLocalHttpProbe,
    sawActivePentestTest: f.sawActivePentestTest,
    sawSuccessfulMutation: f.sawSuccessfulMutation,
    featureAppAsk: context.featureAppAsk,
    projectRoot: context.projectRoot,
    plan: livePlan
      ? {
          kind: livePlan.kind,
          hasVerifiedRuntime: planHasVerifiedRuntime(livePlan),
          tasks: livePlan.tasks,
        }
      : undefined,
    deferResponderReport: context.deferResponderReport,
  };
};
