export type ProgressSignal = "none" | "activity" | "evidence" | "completion";
export type GovernorRecommendation = "continue" | "reflect" | "succeeded";

export interface GovernorState {
  readonly schemaVersion: 2;
  readonly steps: number;
  readonly evidenceTotal: number;
  readonly hypothesisTotal: number;
  readonly consecutiveNoDelta: number;
  readonly resourcesUsed: number;
}

export interface GovernorPolicy {
  /** Normal operating envelope. Crossing it prompts reflection, not success or an automatic stop. */
  readonly resourceEnvelope: number;
  /** Absolute resource limit. Reaching it pauses the turn. */
  readonly emergencyCeiling: number;
  readonly reflectionAfterNoDelta: number;
  readonly pauseAfterNoDelta: number;
  readonly repetitionThreshold: number;
}

export interface ProgressMetrics {
  readonly evidenceDelta?: number;
  readonly hypothesisDelta?: number;
  /** Normalized score from 0 (novel) to 1 (identical repetition). */
  readonly repetitionScore?: number;
  readonly resourceCost?: number;
  readonly policy?: GovernorPolicy;
}

export interface GovernorDecision {
  readonly state: GovernorState;
  readonly shouldContinue: boolean;
  readonly requireEvidence: boolean;
  readonly recommendation: GovernorRecommendation;
  readonly reason: string;
}

export const DEFAULT_GOVERNOR_POLICY: GovernorPolicy = {
  resourceEnvelope: 12,
  emergencyCeiling: 20,
  reflectionAfterNoDelta: 2,
  pauseAfterNoDelta: 4,
  repetitionThreshold: 0.8,
};

export function createGovernorState(): GovernorState {
  return {
    schemaVersion: 2,
    steps: 0,
    evidenceTotal: 0,
    hypothesisTotal: 0,
    consecutiveNoDelta: 0,
    resourcesUsed: 0,
  };
}

function validatePolicy(policy: GovernorPolicy): void {
  const integers = [policy.resourceEnvelope, policy.emergencyCeiling, policy.reflectionAfterNoDelta, policy.pauseAfterNoDelta];
  if (integers.some((value) => !Number.isInteger(value) || value < 1)) throw new Error("governor limits must be positive integers");
  if (policy.emergencyCeiling < policy.resourceEnvelope) throw new Error("emergencyCeiling must be at least resourceEnvelope");
  if (policy.pauseAfterNoDelta < policy.reflectionAfterNoDelta) throw new Error("pauseAfterNoDelta must be at least reflectionAfterNoDelta");
  if (policy.repetitionThreshold < 0 || policy.repetitionThreshold > 1) throw new Error("repetitionThreshold must be between 0 and 1");
}

export function governProgress(
  state: GovernorState,
  signal: ProgressSignal,
  metrics: ProgressMetrics = {},
): GovernorDecision {
  const policy = metrics.policy ?? DEFAULT_GOVERNOR_POLICY;
  validatePolicy(policy);
  const evidenceDelta = metrics.evidenceDelta ?? (signal === "evidence" ? 1 : 0);
  const hypothesisDelta = metrics.hypothesisDelta ?? 0;
  const repetitionScore = metrics.repetitionScore ?? 0;
  const resourceCost = metrics.resourceCost ?? 1;
  if (evidenceDelta < 0 || hypothesisDelta < 0 || resourceCost < 0) throw new Error("progress deltas and resourceCost must be non-negative");
  if (repetitionScore < 0 || repetitionScore > 1) throw new Error("repetitionScore must be between 0 and 1");

  const productive = evidenceDelta > 0 || hypothesisDelta > 0;
  const repetitiveNoDelta = !productive && repetitionScore >= policy.repetitionThreshold;
  const next: GovernorState = {
    schemaVersion: 2,
    steps: state.steps + 1,
    evidenceTotal: state.evidenceTotal + evidenceDelta,
    hypothesisTotal: state.hypothesisTotal + hypothesisDelta,
    consecutiveNoDelta: productive ? 0 : state.consecutiveNoDelta + 1,
    resourcesUsed: state.resourcesUsed + resourceCost,
  };

  if (next.resourcesUsed >= policy.emergencyCeiling) {
    return { state: next, shouldContinue: true, requireEvidence: true, recommendation: "reflect", reason: "resource ceiling reached; reassess before continuing" };
  }
  if (signal === "completion" && evidenceDelta > 0) {
    return { state: next, shouldContinue: false, requireEvidence: false, recommendation: "succeeded", reason: "completion supported by new evidence" };
  }
  if (signal === "completion") {
    return { state: next, shouldContinue: true, requireEvidence: true, recommendation: "reflect", reason: "completion requires new evidence" };
  }
  if (repetitiveNoDelta && next.consecutiveNoDelta >= policy.pauseAfterNoDelta) {
    return { state: next, shouldContinue: true, requireEvidence: true, recommendation: "reflect", reason: "repetitive work produced no evidence or hypothesis progress; change approach" };
  }
  if (repetitiveNoDelta && next.consecutiveNoDelta >= policy.reflectionAfterNoDelta) {
    return { state: next, shouldContinue: true, requireEvidence: true, recommendation: "reflect", reason: "repetitive work requires reflection" };
  }
  if (next.resourcesUsed >= policy.resourceEnvelope) {
    return { state: next, shouldContinue: true, requireEvidence: !productive, recommendation: "reflect", reason: "resource envelope reached; reassess before continuing" };
  }
  return { state: next, shouldContinue: true, requireEvidence: false, recommendation: "continue", reason: productive ? "productive progress recorded" : "within resource envelope" };
}
