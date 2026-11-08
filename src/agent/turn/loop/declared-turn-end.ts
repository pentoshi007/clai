import type { ToolCall } from "../../../types.js";
import { TURN_END_TOOL_NAME } from "../../../tools/turn-end.js";
import {
  declaredFinalAnswer,
  type TurnCompletionState,
} from "../turn-completion.js";

export const isTurnEndCall = (call: Pick<ToolCall, "name">): boolean =>
  call.name === TURN_END_TOOL_NAME;

export type DeclaredTurnEndDecision =
  | { readonly kind: "continue" }
  | { readonly kind: "request-final-message" }
  | {
      readonly kind: "finish";
      readonly answer: string;
      readonly reason: string | undefined;
    };

export interface DeclaredTurnEndInput {
  readonly declared: boolean;
  readonly calls: readonly ToolCall[];
  readonly outcomesNeedReview: boolean;
  readonly visibleText: string;
  readonly stepsBeforeRound: number;
  readonly productiveSteps: number;
  readonly unreadResponders: boolean;
}

const declaredReason = (calls: readonly ToolCall[]): string | undefined => {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index]!;
    if (!isTurnEndCall(call)) continue;
    return typeof call.args.reason === "string" ? call.args.reason : undefined;
  }
  return undefined;
};

export const resolveDeclaredTurnEnd = (
  state: TurnCompletionState,
  input: DeclaredTurnEndInput,
): DeclaredTurnEndDecision => {
  if (!input.declared || input.outcomesNeedReview || input.unreadResponders) {
    return { kind: "continue" };
  }
  state.declaredAtStep = input.productiveSteps;
  const answer = declaredFinalAnswer(
    state,
    input.visibleText,
    input.stepsBeforeRound,
  );
  if (!answer && !state.finalMessageRequested) {
    state.finalMessageRequested = true;
    return { kind: "request-final-message" };
  }
  return { kind: "finish", answer, reason: declaredReason(input.calls) };
};
