export type EscapeCancellationAction =
  | "dismiss"
  | "cancel-all"
  | "abort-foreground";

export function escapeCancellationAction(input: {
  readonly dismissed: boolean;
  readonly doublePress: boolean;
  readonly hasCancelableWork: boolean;
}): EscapeCancellationAction {
  if (input.dismissed) return "dismiss";
  if (input.doublePress && input.hasCancelableWork) return "cancel-all";
  return "abort-foreground";
}

export function preserveEscapeArmAfterTurn(
  hasCancelableWork: boolean,
): boolean {
  return hasCancelableWork;
}
