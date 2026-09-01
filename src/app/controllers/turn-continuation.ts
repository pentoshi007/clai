import type { TurnOutcomeStatus } from "../../agent/turn-outcome.js";
import type { PreviousTurnSignal } from "../../agent/continue-orient.js";
import type { TurnResult } from "./turn-controller.js";

export interface ContinuationDecision {
  readonly proceed: boolean;
  readonly reason?: string | undefined;
}

export function queueContinuationDecision(
  result: TurnResult,
): ContinuationDecision {
  if (result.status === "aborted") {
    return { proceed: false, reason: "the turn was cancelled" };
  }
  if (result.status === "error") {
    return { proceed: false, reason: `the turn failed: ${result.error.message}` };
  }
  if (result.outcome?.status === "aborted") {
    return { proceed: false, reason: "the turn was cancelled" };
  }
  if (result.outcome?.loopGuardStop) {
    return { proceed: false, reason: "the loop guard stopped the turn" };
  }
  return { proceed: true };
}

export function previousTurnSignal(
  result: TurnResult | undefined,
): PreviousTurnSignal | undefined {
  if (!result) return undefined;
  if (result.status === "aborted") return { status: "aborted" };
  if (result.status === "error") {
    return { status: "error", reason: result.error.message };
  }
  const outcome = result.outcome;
  if (!outcome) return undefined;
  return {
    status: outcome.status,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  };
}
