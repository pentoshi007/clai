export interface TurnCompletionState {
  declaredAtStep: number | undefined;
  checkedAtStep: number | undefined;
  checkedReply: string;
  finalMessageRequested: boolean;
}

export const createTurnCompletionState = (): TurnCompletionState => ({
  declaredAtStep: undefined,
  checkedAtStep: undefined,
  checkedReply: "",
  finalMessageRequested: false,
});

export const isTurnEndDeclared = (
  state: TurnCompletionState,
  productiveSteps: number,
): boolean => state.declaredAtStep === productiveSteps;

export const isTurnEndChecked = (
  state: TurnCompletionState,
  productiveSteps: number,
): boolean => state.checkedAtStep === productiveSteps;

export const recordTurnEndCheck = (
  state: TurnCompletionState,
  productiveSteps: number,
  reply: string,
): void => {
  state.checkedAtStep = productiveSteps;
  state.checkedReply = reply;
};

export const declaredFinalAnswer = (
  state: TurnCompletionState,
  visibleText: string,
  stepsBeforeDeclaration: number,
): string => {
  const visible = visibleText.trim();
  if (visible) return visible;
  return state.checkedAtStep === stepsBeforeDeclaration
    ? state.checkedReply.trim()
    : "";
};

export const TURN_END_CHECK_MESSAGE =
  "TURN END CHECK: Your last response ended without a tool call and without declaring turn.end. " +
  "Judge only against the latest user message. If work for it remains that you can do now, make the next tool call and do not repeat your previous response. " +
  "If it is finished, answered, needs the user's input or confirmation, is blocked on something only the user can resolve, or the user told you to stop here, " +
  "call turn.end with the matching reason and write nothing else.";

export const TURN_END_FINAL_MESSAGE_REQUEST =
  "You declared turn.end without a message to the user. Write your final message to the user now, without tool calls.";
