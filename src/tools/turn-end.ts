export const TURN_END_TOOL_NAME = "turn.end";

export const TURN_END_REASONS = [
  "completed",
  "answered",
  "needs_user_input",
  "blocked",
  "stop_requested",
] as const;

export type TurnEndReason = (typeof TURN_END_REASONS)[number];

export const isTurnEndReason = (value: unknown): value is TurnEndReason =>
  typeof value === "string" &&
  (TURN_END_REASONS as readonly string[]).includes(value);
