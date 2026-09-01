import type { ProviderId, ToolCall } from "../../../types.js";
import type { SuccessfulRequestSnapshot } from "../../../types.js";

export interface TurnLoopState {
  provider: ProviderId;
  model: string;
  step: number;
  lastAnswer: string;
  pendingCalls: ToolCall[];
  allowModelFallback: boolean;
  preferModelFallback: boolean;
  retryWithoutThinking: boolean;
  stepMaxTokens: number;
  dispatchedRawRequestTokens: number;
  dispatchedRequestRoute:
    | { provider: ProviderId; model: string }
    | undefined;
  interruptedVisible: string;
  interruptedReasoning: string;
  lowYieldResumptions: number;
  emptyVisibleRetries: number;
  malformedNativeArgsRounds: number;
  truncatedBudgetRounds: number;
  continuationBudgetFloor: number;
  consecutiveSynthesizedRounds: number;
  freeTierConsecutiveFailures: number;
  freeTierLargeContextWarned: boolean;
  freeTierAdvisoryShown: boolean;
  lastSuccessfulRequestSnapshot: SuccessfulRequestSnapshot | undefined;
  batchRemindCalls: Set<ToolCall>;
  batchReminderNote: string;
  codingSession: boolean;
}

export const createTurnLoopState = (input: {
  readonly provider: ProviderId;
  readonly model: string;
  readonly previousSuccessfulRequest: SuccessfulRequestSnapshot | undefined;
}): TurnLoopState => ({
  provider: input.provider,
  model: input.model,
  step: -1,
  lastAnswer: "",
  pendingCalls: [],
  allowModelFallback: false,
  preferModelFallback: false,
  retryWithoutThinking: false,
  stepMaxTokens: 0,
  dispatchedRawRequestTokens: 0,
  dispatchedRequestRoute: undefined,
  interruptedVisible: "",
  interruptedReasoning: "",
  lowYieldResumptions: 0,
  emptyVisibleRetries: 0,
  malformedNativeArgsRounds: 0,
  truncatedBudgetRounds: 0,
  continuationBudgetFloor: 0,
  consecutiveSynthesizedRounds: 0,
  freeTierConsecutiveFailures: 0,
  freeTierLargeContextWarned: false,
  freeTierAdvisoryShown: false,
  lastSuccessfulRequestSnapshot: input.previousSuccessfulRequest,
  batchRemindCalls: new Set(),
  batchReminderNote: "",
  codingSession: false,
});
