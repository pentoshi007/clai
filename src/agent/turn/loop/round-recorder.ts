import type { ToolCall, ToolResult } from "../../../types.js";
import type { RecoveryBudgets } from "../../must-continue.js";
import type { TurnEvidenceFlags } from "../evidence-flags.js";
import type { TurnCounters } from "../turn-counters.js";
import type { RoundState } from "./round-state.js";
import { completedOperationObservationDigest } from "../../outcomes.js";
import { applyToolEvidenceSignals } from "../evidence-flags.js";
import { readToolEvidenceSignals } from "../tool-evidence-signals.js";
import { resetToolRetryCounters } from "../turn-counters.js";

export interface RecordedToolResult {
  readonly call: ToolCall;
  readonly result: ToolResult;
  readonly contextOutput: string;
  readonly ok: boolean;
  readonly aborted?: boolean | undefined;
  readonly suppressedRepeat?: boolean | undefined;
  readonly blockOrCancel?: boolean | undefined;
}

export interface RoundRecorderPorts {
  readonly round: RoundState;
  readonly counters: TurnCounters;
  readonly evidenceFlags: TurnEvidenceFlags;
  readonly recovery: RecoveryBudgets;
  readonly isPlanMode: boolean;
  readonly pentestTurn: boolean;
  readonly planApproved: () => boolean;
  readonly approvePlan: () => void;
  readonly priorObservation: (call: ToolCall) => string | undefined;
  readonly projectRoot: () => string | undefined;
  readonly kindHint: () => "pentest" | "coding" | "general";
  readonly recordHistory: (entry: {
    id: string;
    call: ToolCall;
    result: ToolResult;
    contextOutput: string;
    isPlanMode: boolean;
    planApproved: boolean;
    hasDraftPlan: boolean;
    productiveStep: number;
    kindHint: "pentest" | "coding" | "general";
  }) => void;
  readonly onPlanCreated: (kind: string | undefined) => void;
}

const sequenceOutcome = (
  ports: RoundRecorderPorts,
  res: RecordedToolResult,
): string => {
  const observation = res.suppressedRepeat
    ? (ports.priorObservation(res.call) ?? res.contextOutput)
    : (res.result.output ?? res.contextOutput);
  return JSON.stringify({
    ok: res.ok,
    exitCode: res.result.exitCode ?? null,
    digest: completedOperationObservationDigest(res.call.name, observation),
  });
};

const applyEvidence = (
  ports: RoundRecorderPorts,
  res: RecordedToolResult,
): void => {
  applyToolEvidenceSignals(
    ports.evidenceFlags,
    ports.recovery,
    readToolEvidenceSignals({
      call: res.call,
      ok: res.ok,
      output: res.result.output ?? res.contextOutput ?? "",
      pentestTurn: ports.pentestTurn,
      activeProjectRoot: ports.projectRoot(),
    }),
  );
  if (res.call.name === "instructions.record" && res.ok) {
    ports.evidenceFlags.instructionsChangedThisRound = true;
  }
};

const applyPlanCreation = (
  ports: RoundRecorderPorts,
  res: RecordedToolResult,
): void => {
  if (res.call.name !== "plan.create" || !res.ok) return;
  ports.evidenceFlags.sawPlanCreateOk = true;
  if (ports.isPlanMode) ports.round.awaitingPlanApproval = true;
  else ports.approvePlan();
  ports.onPlanCreated(
    typeof res.call.args.kind === "string" ? res.call.args.kind : undefined,
  );
};

export const createRoundRecorder =
  (ports: RoundRecorderPorts) =>
  (id: string, res: RecordedToolResult): void => {
    const { round, counters } = ports;
    counters.consecutiveModelOnlyRounds = 0;
    round.recordedNativeIds.add(id);
    round.actionSequenceExecuted += 1;
    if (res.suppressedRepeat) round.roundSuppressedCount += 1;
    round.actionSequenceOutcomes.set(id, sequenceOutcome(ports, res));
    round.actionSequenceEligible &&=
      (res.ok || Boolean(res.suppressedRepeat)) &&
      !res.blockOrCancel &&
      !res.aborted;
    if (res.ok && res.call.name === "plan.create") {
      round.planCreatedThisTurn = true;
    }
    if (!res.suppressedRepeat) counters.productiveSteps += 1;
    ports.recordHistory({
      id,
      call: res.call,
      result: res.result,
      contextOutput: res.contextOutput,
      isPlanMode: ports.isPlanMode,
      planApproved: ports.planApproved(),
      hasDraftPlan: round.planCreatedThisTurn,
      productiveStep: counters.productiveSteps,
      kindHint: ports.kindHint(),
    });
    resetToolRetryCounters(counters);
    applyEvidence(ports, res);
    applyPlanCreation(ports, res);
    if (res.aborted) round.aborted = true;
  };
