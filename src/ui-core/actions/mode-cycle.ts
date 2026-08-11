import type { Mode } from "../../types.js";

// Order Shift+Tab walks through. Kept as data so the status hint and tests
// read the same source of truth.
export const MODE_CYCLE_ORDER: readonly Mode[] = ["ask", "agent", "plan"];

/** Next mode in the cycle, wrapping around; unknown modes fall back to first. */
export function nextMode(current: Mode): Mode {
  const index = MODE_CYCLE_ORDER.indexOf(current);
  if (index < 0) return MODE_CYCLE_ORDER[0]!;
  return MODE_CYCLE_ORDER[(index + 1) % MODE_CYCLE_ORDER.length]!;
}

/** One-line description of what each mode does, for the switch toast. */
export function modeSwitchSummary(mode: Mode): string {
  switch (mode) {
    case "ask":
      return "read-only answers & research";
    case "plan":
      return "draft a plan before executing";
    case "agent":
    default:
      return "execute tasks with tools";
  }
}
