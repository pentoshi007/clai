import { createHash } from "node:crypto";
import type { ChatMessage, ToolCall } from "../../../types.js";
import type { SessionPlan } from "../../../store/plan.js";
import type { LoopGuardStopInfo } from "../../turn-outcome.js";
import type { ResponderNotification } from "../../../tools/jobs.js";
import { formatToolArgs } from "../../tool-call-parser.js";
import {
  appendToolResult,
  fillMissingToolResults,
} from "../../tool-history.js";
import { upsertResponderResultLedger } from "../../responder-context.js";

export interface RoundBoundCall {
  readonly id: string;
  readonly call: ToolCall;
}

export interface RoundCloseoutState {
  consecutiveSynthesizedRounds: number;
}

export interface RoundCloseoutPorts {
  readonly messages: ChatMessage[];
  readonly recordedNativeIds: Set<string>;
  readonly historyNativeCalls: readonly { id: string; name: string }[];
  readonly deferReason: string;
  readonly priorObservation: (call: ToolCall) => string | undefined;
  readonly completeActionSequence: (eligible: boolean, outcome: string) => void;
  readonly currentSignature: () => string | undefined;
  readonly drainResponderLedger: () => ResponderNotification[];
  readonly refreshInstructions: () => Promise<void>;
  readonly refreshSessionState: (plan: SessionPlan | null | undefined) => void;
  readonly recoveryUserMessage: (content: string) => ChatMessage;
  readonly drainDeferredMessages: () => ChatMessage[];
}

export interface RoundCloseoutInput {
  readonly bound: readonly RoundBoundCall[];
  readonly runIds: ReadonlySet<string>;
  readonly outcomes: ReadonlyMap<string, string>;
  readonly sequenceEligible: boolean;
  readonly executedCount: number;
  readonly plannedCount: number;
  readonly runCount: number;
  readonly suppressedCount: number;
  readonly aborted: boolean;
  readonly awaitingPlanApproval: boolean;
  readonly instructionsChanged: boolean;
  readonly pendingSessionStatePlan: SessionPlan | null | undefined;
  readonly responderWakeTurn: boolean;
  readonly unreadResponderResults: boolean;
  readonly calledResponderRead: boolean;
}

export interface RoundCloseoutStop {
  readonly kind: "stop";
  readonly answer: string;
  readonly remainingCriteria: readonly string[];
  readonly reason: string;
  readonly loopGuardStop: LoopGuardStopInfo;
}

export type RoundCloseoutDecision =
  | { readonly kind: "proceed" }
  | RoundCloseoutStop;

const UNREAD_RESPONDER_NUDGE =
  "The delivered Responder result is still unread. Decide from the evidence already available whether it is understood. If it is, call job.read now; if not, gather only the smallest bounded evidence needed. Do not resume or repeat unrelated foreground work before resolving this receipt.";

const fillSyntheticResults = (
  ports: RoundCloseoutPorts,
  input: RoundCloseoutInput,
): void => {
  if (ports.historyNativeCalls.length === 0) return;
  for (const bound of input.bound) {
    if (input.runIds.has(bound.id) || ports.recordedNativeIds.has(bound.id)) {
      continue;
    }
    appendToolResult(
      ports.messages,
      bound.id,
      `Tool ${bound.call.name} result (exit=130, ok=false):\n${ports.deferReason}`,
      bound.call.name,
      false,
    );
    ports.recordedNativeIds.add(bound.id);
  }
  fillMissingToolResults(
    ports.messages,
    [...ports.historyNativeCalls] as never,
    "Cancelled — not executed this turn.",
  );
};

const sequenceOutcomeHash = (input: RoundCloseoutInput): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        input.bound.map((entry) => input.outcomes.get(entry.id) ?? null),
      ),
    )
    .digest("hex")
    .slice(0, 24);

const repeatedCycleStop = (
  ports: RoundCloseoutPorts,
  input: RoundCloseoutInput,
): RoundCloseoutStop => {
  const repeatedList = input.bound
    .map((bound) => `${bound.call.name} ${formatToolArgs(bound.call)}`)
    .join("; ");
  const observation = input.bound
    .map((bound) => ports.priorObservation(bound.call))
    .find((text) => typeof text === "string" && text.trim().length > 0);
  return {
    kind: "stop",
    answer: `Stopped an identical action cycle: consecutive rounds re-issued calls whose results are already in context (${repeatedList}). Continue from those results or take a materially different action.`,
    remainingCriteria: [
      "Continue with a materially different action that can produce new evidence.",
    ],
    reason: "Every call in consecutive rounds repeated already-answered work.",
    loopGuardStop: {
      calls: repeatedList,
      ...(observation?.trim()
        ? { observation: observation.trim().slice(0, 4000) }
        : {}),
      signature: ports.currentSignature() ?? repeatedList,
    },
  };
};

export const closeOutRound = async (
  ports: RoundCloseoutPorts,
  state: RoundCloseoutState,
  input: RoundCloseoutInput,
): Promise<RoundCloseoutDecision> => {
  fillSyntheticResults(ports, input);
  ports.completeActionSequence(
    input.sequenceEligible &&
      input.runCount === input.bound.length &&
      input.executedCount === input.plannedCount &&
      !input.aborted &&
      !input.awaitingPlanApproval,
    sequenceOutcomeHash(input),
  );

  const allSuppressed =
    !input.aborted &&
    input.executedCount > 0 &&
    input.suppressedCount === input.executedCount;
  state.consecutiveSynthesizedRounds = allSuppressed
    ? state.consecutiveSynthesizedRounds + 1
    : 0;
  if (state.consecutiveSynthesizedRounds >= 2) {
    return repeatedCycleStop(ports, input);
  }

  for (const notification of ports.drainResponderLedger()) {
    upsertResponderResultLedger(ports.messages, notification);
  }
  if (input.instructionsChanged) await ports.refreshInstructions();
  ports.refreshSessionState(input.pendingSessionStatePlan);

  if (
    input.responderWakeTurn &&
    input.unreadResponderResults &&
    !input.calledResponderRead
  ) {
    ports.messages.push(ports.recoveryUserMessage(UNREAD_RESPONDER_NUDGE));
  }
  const deferred = ports.drainDeferredMessages();
  if (deferred.length > 0) ports.messages.push(...deferred);
  return { kind: "proceed" };
};
