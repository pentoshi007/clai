export interface RoundState {
  aborted: boolean;
  awaitingPlanApproval: boolean;
  planCreatedThisTurn: boolean;
  actionSequenceExecuted: number;
  roundSuppressedCount: number;
  actionSequenceEligible: boolean;
  readonly recordedNativeIds: Set<string>;
  readonly actionSequenceOutcomes: Map<string, string>;
}

export const createRoundState = (
  hasDraftPlan: boolean,
  callCount: number,
): RoundState => ({
  aborted: false,
  awaitingPlanApproval: false,
  planCreatedThisTurn: hasDraftPlan,
  actionSequenceExecuted: 0,
  roundSuppressedCount: 0,
  actionSequenceEligible: callCount > 0,
  recordedNativeIds: new Set<string>(),
  actionSequenceOutcomes: new Map<string, string>(),
});
