import {
  createTurnCompletionState,
  type TurnCompletionState,
} from "./turn-completion.js";

export interface TurnCounters {
  productiveSteps: number;
  consecutiveModelOnlyRounds: number;
  truncatedToolRetries: number;
  malformedFenceRetries: number;
  bareToolJsonRetries: number;
  sentinelToolRetries: number;
  readonly completion: TurnCompletionState;
}

export const createTurnCounters = (): TurnCounters => ({
  productiveSteps: 0,
  consecutiveModelOnlyRounds: 0,
  truncatedToolRetries: 0,
  malformedFenceRetries: 0,
  bareToolJsonRetries: 0,
  sentinelToolRetries: 0,
  completion: createTurnCompletionState(),
});

export const resetToolRetryCounters = (counters: TurnCounters): void => {
  counters.truncatedToolRetries = 0;
  counters.malformedFenceRetries = 0;
  counters.bareToolJsonRetries = 0;
  counters.sentinelToolRetries = 0;
};
