
export interface ArrowIntentInput {
  readonly chord: string;
  readonly plainText: string;
  readonly line: number;
  readonly lineCount: number;
  readonly menuOpen: boolean;
  readonly isBrowsingHistory: boolean;
  readonly burstCount: number;
}

export type ArrowIntent = "scroll-chat" | "history" | "ignore";

export const ARROW_BURST_THRESHOLD = 3;
export const ARROW_BURST_WINDOW_MS = 80;

export function resolveArrowIntent(input: ArrowIntentInput): ArrowIntent {
  if (input.menuOpen) return "ignore";

  const isUp = input.chord === "up" || input.chord.endsWith("+up");
  const isDown = input.chord === "down" || input.chord.endsWith("+down");
  if (!isUp && !isDown) return "ignore";

  const bare = input.chord === "up" || input.chord === "down";

  if (bare && input.burstCount >= ARROW_BURST_THRESHOLD) return "scroll-chat";

  if (bare) {
    if (input.chord === "up" && input.line > 0) return "ignore";
    if (input.chord === "down" && input.line < input.lineCount - 1) return "ignore";
  }

  return "history";
}
