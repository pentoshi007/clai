export type EscapeCancellationAction =
  | "dismiss"
  | "arm"
  | "cancel-all"
  | "none";

export function escapeCancellationAction(input: {
  readonly dismissed: boolean;
  readonly doublePress: boolean;
  readonly hasCancelableWork: boolean;
}): EscapeCancellationAction {
  if (input.dismissed) return "dismiss";
  if (!input.hasCancelableWork) return "none";
  return input.doublePress ? "cancel-all" : "arm";
}

export function preserveEscapeArmAfterTurn(
  hasCancelableWork: boolean,
): boolean {
  return hasCancelableWork;
}
