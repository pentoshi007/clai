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
