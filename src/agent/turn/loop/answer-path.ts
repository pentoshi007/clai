import { auditLog } from "../../../store/logs.js";
import { loadPlan } from "../../../store/plan.js";
import { saveOutcomeState } from "../../outcomes.js";
import { assessCompletion } from "../../turn/loop/answer-assessment.js";
import { resolveFinalOutcome } from "../../turn/loop/final-outcome.js";
import { handleModelOnlyRound } from "../../turn/loop/model-only-rounds.js";
import { recoverMissingToolCall } from "../../turn/loop/tool-call-recovery.js";
import {
  isTurnEndChecked,
  isTurnEndDeclared,
  recordTurnEndCheck,
} from "../turn-completion.js";
import type { TurnOutcome } from "../../turn-outcome.js";
import type { TurnLoopDeps } from "./deps.js";

export type AnswerPathResult =
  | { readonly kind: "continue" }
  | { readonly kind: "finished"; readonly outcome: TurnOutcome };

const finished = (outcome: TurnOutcome): AnswerPathResult => ({
  kind: "finished",
  outcome,
});

export interface AnswerPathInput {
  readonly assistantText: {
    visible: string;
    thinkContent: string;
    hasThinking: boolean;
  };
  readonly canonicalAssistantVisible: string;
  readonly bareArgsOnly: boolean;
  readonly toolsAttached: boolean;
  readonly roundsRemain: boolean;
  readonly commitAssistantRetry: (historyText: string) => void;
}

export const resolveAnswerPath = async (
  deps: TurnLoopDeps,
  input: AnswerPathInput,
): Promise<AnswerPathResult> => {
  const { assistantText, canonicalAssistantVisible, bareArgsOnly, toolsAttached, commitAssistantRetry } =
    input;
  deps.counters.consecutiveModelOnlyRounds += 1;
  const recoveryLadderState = {
    bareToolJsonRetries: deps.counters.bareToolJsonRetries,
    truncatedToolRetries: deps.counters.truncatedToolRetries,
    malformedFenceRetries: deps.counters.malformedFenceRetries,
    sentinelToolRetries: deps.counters.sentinelToolRetries,
  };
  const recoveryDecision = await recoverMissingToolCall(
    {
      messages: deps.messages,
      toolsAttached,
      planModeWithoutPlan: deps.isPlanMode && !deps.activePlan,
      notify: deps.writeNotice,
      commitAssistantRetry,
      recoveryUserMessage: deps.recoveryUserMessage,
      applySalvagedWrite: deps.applySalvagedWrite,
    },
    recoveryLadderState,
    { visible: assistantText.visible, thinking: assistantText.thinkContent, bareArgsOnly },
  );
  deps.counters.bareToolJsonRetries = recoveryLadderState.bareToolJsonRetries;
  deps.counters.truncatedToolRetries = recoveryLadderState.truncatedToolRetries;
  deps.counters.malformedFenceRetries = recoveryLadderState.malformedFenceRetries;
  deps.counters.sentinelToolRetries = recoveryLadderState.sentinelToolRetries;
  if (recoveryDecision === "retry") return { kind: "continue" };

  const livePlanAtCompletion = await loadPlan(deps.session.sessionId);
  const assessment = assessCompletion({
    visible: assistantText.visible,
    canonicalVisible: canonicalAssistantVisible,
    livePlan: livePlanAtCompletion,
    activePlanStatus: deps.activePlan?.status,
    planApproved: deps.session.planApproved.value,
    informationalQuery: deps.informationalQuery,
    idleOrSocialPrompt: deps.idleOrSocialPrompt,
    buildLikeTurn: deps.buildLikeTurn,
    pentestLikeTurn: deps.pentestLikeTurn,
  });
  const cleaned = assessment.cleaned;
  const displayCleaned = assessment.displayCleaned;

  const modelOnly = handleModelOnlyRound(
    {
      messages: deps.messages,
      provider: deps.loop.provider,
      model: deps.loop.model,
      toolsAttached,
      canDeclareTurnEnd:
        input.roundsRemain && (toolsAttached || !deps.nativeToolsActive()),
      notify: deps.writeNotice,
      commitAssistantRetry,
      recoveryUserMessage: deps.recoveryUserMessage,
      writeAssistantMessage: deps.writeAssistantMessage,
      unreadResponderIds: () => deps.responderClaims.ids(),
    },
    {
      assistantVisible: assistantText.visible,
      wantsAction: assessment.wantsAction,
      turnEndDeclared: isTurnEndDeclared(
        deps.counters.completion,
        deps.counters.productiveSteps,
      ),
      turnEndChecked: isTurnEndChecked(
        deps.counters.completion,
        deps.counters.productiveSteps,
      ),
      consecutiveModelOnlyRounds: deps.counters.consecutiveModelOnlyRounds,
      plan: livePlanAtCompletion,
    },
  );
  if (modelOnly.kind === "continue-round") return { kind: "continue" };
  if (modelOnly.kind === "turn-end-check") {
    recordTurnEndCheck(
      deps.counters.completion,
      deps.counters.productiveSteps,
      cleaned,
    );
    await auditLog("agent.turn_end_check", {
      provider: deps.loop.provider,
      model: deps.loop.model,
      productiveSteps: deps.counters.productiveSteps,
    });
    return { kind: "continue" };
  }
  if (modelOnly.kind === "stop") {
    deps.outcomeState.outcome.status = "partial";
    await saveOutcomeState(deps.outcomeState);
    deps.moveTurn("partial", "repeated model-only responses");
    return finished(deps.finishTurn(
      modelOnly.answer,
      deps.counters.productiveSteps,
      "partial",
      modelOnly.remainingCriteria,
      modelOnly.reason,
    ));
  }

  return finished(await finishWithAnswer(deps, {
    answer: cleaned,
    displayAnswer: deps.loop.interruptedVisible ? cleaned : displayCleaned,
    turnEndReason: undefined,
  }));
};

export const finishWithAnswer = async (
  deps: TurnLoopDeps,
  input: {
    readonly answer: string;
    readonly displayAnswer: string;
    readonly turnEndReason: string | undefined;
  },
): Promise<TurnOutcome> => {
  const finalOutcome = await resolveFinalOutcome(
    {
      outcomeState: deps.outcomeState,
      planApproved: deps.session.planApproved.value,
      loadPlan: () =>
        loadPlan(deps.session.sessionId),
      saveOutcomeState,
    },
    input.answer,
  );
  const outcomeStatus = finalOutcome.status;
  const remainingCriteria = finalOutcome.remainingCriteria;
  deps.moveTurn("verifying", "evaluating current criterion-linked evidence");
  deps.moveTurn(outcomeStatus, `turn completed with ${outcomeStatus} evidence status`);
  await auditLog("agent.final", {
    provider: deps.loop.provider,
    model: deps.loop.model,
    steps: deps.loop.step + 1,
    outcomeStatus,
    remainingCriteria,
    turnEndReason: input.turnEndReason,
  });
  deps.loop.lastAnswer = input.answer;
  return deps.finishTurn(
    deps.loop.lastAnswer,
    deps.loop.step + 1,
    outcomeStatus,
    remainingCriteria,
    finalOutcome.reason,
    input.displayAnswer,
  );
};
