import type { ChatMessage } from "../../types.js";
import type { LoopGuardStopInfo } from "../turn-outcome.js";
import type { TurnOutcome, TurnOutcomeStatus } from "../turn-outcome.js";
import {
  createTurnOutcome,
  normalizeTurnOutcomeInput,
  renderTurnOutcome,
} from "../turn-outcome.js";
import { buildTurnHistory } from "../tool-call-parser.js";

export interface TurnFinalizerPorts {
  readonly releaseResponderClaims: () => void;
  readonly liveMessages: () => ChatMessage[];
  readonly diagnostics: () => boolean;
  readonly writeAssistantMessage: (text: string) => void;
  readonly emitEmptyAssistantMessage: () => void;
  readonly emitTurnEnd: (input: {
    outcome: TurnOutcome;
    finalAnswer: string;
    steps: number;
  }) => void;
  readonly onMessages: ((messages: ChatMessage[]) => void) | undefined;
  readonly onOutcome: ((outcome: TurnOutcome) => void) | undefined;
}

export interface TurnFinalizerInput {
  readonly answer: string;
  readonly steps: number;
  readonly status: TurnOutcomeStatus;
  readonly remainingCriteria: readonly string[];
  readonly reason: string | undefined;
  readonly displayAnswer: string | undefined;
  readonly loopGuardStop: LoopGuardStopInfo | undefined;
}

export const finalizeTurn = (
  ports: TurnFinalizerPorts,
  input: TurnFinalizerInput,
): TurnOutcome => {
  ports.releaseResponderClaims();
  const outcome = createTurnOutcome(
    normalizeTurnOutcomeInput({
      status: input.status,
      answer: input.answer,
      steps: input.steps,
      remainingCriteria: input.remainingCriteria,
      reason: input.reason,
      ...(input.loopGuardStop ? { loopGuardStop: input.loopGuardStop } : {}),
    }),
  );
  const renderOptions = { diagnostics: ports.diagnostics() };
  const rendered = renderTurnOutcome(outcome, renderOptions);
  const displayRendered =
    input.displayAnswer === undefined
      ? rendered
      : renderTurnOutcome(
          { ...outcome, answer: input.displayAnswer },
          renderOptions,
        );
  if (displayRendered.trim()) {
    ports.writeAssistantMessage(displayRendered);
  } else {
    ports.emitEmptyAssistantMessage();
  }
  if (ports.onMessages) {
    try {
      ports.onMessages(buildTurnHistory(ports.liveMessages(), displayRendered));
    } catch {
      // Persisting history must never break the turn.
    }
  }
  ports.onOutcome?.(outcome);
  ports.emitTurnEnd({ outcome, finalAnswer: rendered, steps: input.steps });
  return outcome;
};
