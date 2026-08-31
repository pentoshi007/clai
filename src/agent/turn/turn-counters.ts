export interface TurnCounters {
  productiveSteps: number;
  consecutiveModelOnlyRounds: number;
  truncatedToolRetries: number;
  malformedFenceRetries: number;
  bareToolJsonRetries: number;
}

export const createTurnCounters = (): TurnCounters => ({
  productiveSteps: 0,
  consecutiveModelOnlyRounds: 0,
  truncatedToolRetries: 0,
  malformedFenceRetries: 0,
  bareToolJsonRetries: 0,
});

export const resetToolRetryCounters = (counters: TurnCounters): void => {
  counters.truncatedToolRetries = 0;
  counters.malformedFenceRetries = 0;
  counters.bareToolJsonRetries = 0;
};
