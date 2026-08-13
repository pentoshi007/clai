/**
 * Pure finalize-time gate: pick the recovery nudge that must replace a final
 * answer, or nothing when the turn may finalize. No I/O, no budget mutation.
 */
import {
  budgetRemaining,
  looksLikeShallowPentestReport,
  recoveryForErrorDiagnosis,
  recoveryForFailedProbe,
  recoveryForMissingFeature,
  recoveryForMissingPlan,
  recoveryForNarration,
  recoveryForShallowPentest,
  type RecoveryAction,
  type RecoveryBudgets,
} from "./must-continue.js";
import {
  looksLikeErrorDiagnosisWithFixIntent,
  looksLikePlanNarration,
} from "./tool-call-parser.js";

/** Task fields the gate reads. */
export interface FinalizeGatePlanTask {
  id: string;
  title: string;
  state: string;
  responderOwned?: boolean | undefined;
}

/** Plain-data snapshot of the live plan, resolved once by the caller. */
export interface FinalizeGatePlan {
  kind: string;
  hasVerifiedRuntime: boolean;
  tasks: readonly FinalizeGatePlanTask[];
}

/** Everything the finalize cascade reads, as data. */
export interface FinalizeGateInput {
  cleaned: string;
  recovery: RecoveryBudgets;
  toolsAttached: boolean;
  productiveSteps: number;
  planApproved: boolean;
  planHasOpenWork: boolean;
  activePlanExists: boolean;
  wantsAction: boolean;
  narratedAction: boolean;
  narratedWebAction: boolean;
  isPlanMode: boolean;
  buildLikeTurn: boolean;
  pentestLikeTurn: boolean;
  buildLike: boolean;
  pentestLike: boolean;
  pentestSession: boolean;
  informationalQuery: boolean;
  idleOrSocialPrompt: boolean;
  sawPlanCreateOk: boolean;
  sawFeatureImplWrite: boolean;
  sawScaffoldOk: boolean;
  sawLocalAppMaterialWork: boolean;
  sawServerStart: boolean;
  sawServerTail: boolean;
  sawLocalHttpProbe: boolean;
  sawFailedLocalHttpProbe: boolean;
  sawActivePentestTest: boolean;
  sawSuccessfulMutation: boolean;
  featureAppAsk: boolean;
  projectRoot: string | undefined;
  plan: FinalizeGatePlan | undefined;
  deferResponderReport: boolean;
}

export function chooseFinalizeRecovery(
  input: FinalizeGateInput,
): RecoveryAction | undefined {
  const { cleaned, recovery, toolsAttached, productiveSteps, plan } = input;

  const planNarrated =
    (input.buildLikeTurn || input.pentestLikeTurn) &&
    !input.activePlanExists &&
    productiveSteps === 0 &&
    looksLikePlanNarration(cleaned);
  const errorFixNarration =
    !input.sawSuccessfulMutation &&
    looksLikeErrorDiagnosisWithFixIntent(cleaned);

  const shouldRetryBeforeFinalizing =
    productiveSteps === 0 ||
    planNarrated ||
    ((input.narratedAction || input.narratedWebAction) &&
      !input.informationalQuery) ||
    (input.planApproved &&
      input.planHasOpenWork &&
      (input.narratedAction || errorFixNarration)) ||
    (input.planApproved && errorFixNarration) ||
    (input.buildLikeTurn && errorFixNarration);
  if (
    input.wantsAction &&
    cleaned.trim().length > 0 &&
    shouldRetryBeforeFinalizing
  ) {
    let action: RecoveryAction | undefined;
    if (errorFixNarration && budgetRemaining(recovery, "errorFix")) {
      action = recoveryForErrorDiagnosis(toolsAttached);
    } else if (
      budgetRemaining(recovery, "actionIntent") &&
      input.planHasOpenWork &&
      input.planApproved
    ) {
      action = recoveryForNarration(toolsAttached, "plan_open");
    } else if (
      budgetRemaining(recovery, "actionIntent") &&
      input.pentestLikeTurn
    ) {
      action = recoveryForNarration(toolsAttached, "pentest");
    } else if (
      budgetRemaining(recovery, "actionIntent") &&
      input.narratedWebAction
    ) {
      action = recoveryForNarration(toolsAttached, "web");
    } else if (
      budgetRemaining(recovery, "actionIntent") &&
      input.buildLikeTurn &&
      planNarrated
    ) {
      action = recoveryForNarration(toolsAttached, "build_plan_prose");
    } else if (
      budgetRemaining(recovery, "actionIntent") &&
      input.buildLikeTurn
    ) {
      action = recoveryForNarration(toolsAttached, "build");
    } else if (budgetRemaining(recovery, "actionIntent")) {
      action = recoveryForNarration(toolsAttached, "generic");
    }
    if (action) return action;
  }

  if (
    input.isPlanMode &&
    !input.informationalQuery &&
    !input.idleOrSocialPrompt &&
    budgetRemaining(recovery, "forcePlan")
  ) {
    if (!plan && !input.sawPlanCreateOk) {
      return recoveryForMissingPlan(toolsAttached);
    }
  }

  if (
    input.buildLike &&
    !input.pentestLike &&
    !input.pentestSession &&
    input.planApproved &&
    input.featureAppAsk &&
    !input.sawFeatureImplWrite &&
    (input.sawScaffoldOk || input.sawLocalAppMaterialWork) &&
    productiveSteps > 0 &&
    budgetRemaining(recovery, "featureImpl")
  ) {
    return recoveryForMissingFeature(input.projectRoot);
  }

  if (
    input.buildLike &&
    !input.pentestLike &&
    !input.pentestSession &&
    input.sawFailedLocalHttpProbe &&
    !input.sawLocalHttpProbe &&
    budgetRemaining(recovery, "failedProbe") &&
    cleaned.trim().length > 0
  ) {
    return recoveryForFailedProbe();
  }
  if (
    input.buildLike &&
    !input.pentestLike &&
    !input.pentestSession &&
    input.sawFailedLocalHttpProbe &&
    !input.sawLocalHttpProbe &&
    budgetRemaining(recovery, "failedProbe") &&
    cleaned.trim().length > 0
  ) {
    return recoveryForFailedProbe();
  }

  if (
    (input.pentestLike || input.pentestSession) &&
    budgetRemaining(recovery, "shallowPentest") &&
    looksLikeShallowPentestReport(cleaned, {
      productiveSteps,
      sawActiveTest: input.sawActivePentestTest,
    })
  ) {
    return recoveryForShallowPentest();
  }

  return undefined;
}
