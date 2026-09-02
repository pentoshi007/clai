import type { Mode } from "../../types.js";

export const MODE_CYCLE_ORDER: readonly Mode[] = ["ask", "agent", "plan"];

export function nextMode(current: Mode): Mode {
  const index = MODE_CYCLE_ORDER.indexOf(current);
  if (index < 0) return MODE_CYCLE_ORDER[0]!;
  return MODE_CYCLE_ORDER[(index + 1) % MODE_CYCLE_ORDER.length]!;
}

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
