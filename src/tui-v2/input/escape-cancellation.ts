export type EscapeCancellationAction =
  | "dismiss"
  | "arm"
  | "cancel-foreground"
  | "none";

export function escapeCancellationAction(input: {
  readonly dismissed: boolean;
  readonly doublePress: boolean;
  readonly hasForegroundWork: boolean;
}): EscapeCancellationAction {
  if (input.dismissed) return "dismiss";
  if (!input.hasForegroundWork) return "none";
  return input.doublePress ? "cancel-foreground" : "arm";
}

export function preserveEscapeArmAfterTurn(
  hasForegroundWork: boolean,
): boolean {
  return hasForegroundWork;
}
