/**
 * Decide whether ↑/↓ in the composer should recall prompts or scroll chat.
 *
 * Classic CLAI: bare ↑/↓ at the line boundary walks prompt history (including
 * empty input). Wheel/trackpad still scrolls the transcript via mouse handlers.
 * Only rapid arrow *bursts* (trackpad emulating keys without mouse reporting)
 * are treated as chat scroll so history remains the default for deliberate keys.
 */

export interface ArrowIntentInput {
  readonly chord: string;
  readonly plainText: string;
  readonly line: number;
  readonly lineCount: number;
  readonly menuOpen: boolean;
  readonly isBrowsingHistory: boolean;
  /** Count of ↑/↓ presses in a short window (trackpad→arrow emulation). */
  readonly burstCount: number;
}

export type ArrowIntent = "scroll-chat" | "history" | "ignore";

/** Trackpad-as-arrows often fires several key repeats within ~100ms. */
export const ARROW_BURST_THRESHOLD = 3;
export const ARROW_BURST_WINDOW_MS = 80;

export function resolveArrowIntent(input: ArrowIntentInput): ArrowIntent {
  if (input.menuOpen) return "ignore";

  const isUp = input.chord === "up" || input.chord.endsWith("+up");
  const isDown = input.chord === "down" || input.chord.endsWith("+down");
  if (!isUp && !isDown) return "ignore";

  // Bare up/down only for normal path; modifier chords still count as history.
  const bare = input.chord === "up" || input.chord === "down";

  // Rapid repeats ≈ trackpad without mouse reporting → scroll chat, not history.
  if (bare && input.burstCount >= ARROW_BURST_THRESHOLD) return "scroll-chat";

  // Multi-line edit: only at the top/bottom line boundary may history take over
  // (otherwise let the textarea move the cursor between lines).
  if (bare) {
    if (input.chord === "up" && input.line > 0) return "ignore";
    if (input.chord === "down" && input.line < input.lineCount - 1) return "ignore";
  }

  // Classic: ↑/↓ at boundary (empty or not) walks prompt history.
  return "history";
}
