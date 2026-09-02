
import { easeInCubic, easeOutCubic, clamp01 } from "../../../ui-core/motion/ease.js";

export const PLAN_PANE_ENTER_MS = 120;
export const PLAN_PANE_EXIT_MS = 100;

export type PaneAnimPhase = "enter" | "open" | "exit" | "closed";

export interface PaneAnimState {
  readonly phase: PaneAnimPhase;
  readonly progress: number;
  readonly mounted: boolean;
}

export function paneProgress(
  phase: PaneAnimPhase,
  ageMs: number,
  enterMs: number = PLAN_PANE_ENTER_MS,
  exitMs: number = PLAN_PANE_EXIT_MS,
): number {
  const age = Math.max(0, ageMs);
  switch (phase) {
    case "closed":
      return 0;
    case "open":
      return 1;
    case "enter":
      return easeOutCubic(clamp01(age / Math.max(1, enterMs)));
    case "exit":
      return 1 - easeInCubic(clamp01(age / Math.max(1, exitMs)));
    default:
      return 0;
  }
}

export function paneMounted(phase: PaneAnimPhase): boolean {
  return phase !== "closed";
}

export function paneSlideTop(
  progress: number,
  restTop: number,
  paneHeight: number,
): number {
  const p = clamp01(progress);
  const hiddenTop = -Math.max(1, paneHeight);
  return Math.round(hiddenTop + (restTop - hiddenTop) * p);
}

export function paneSlideWidth(progress: number, fullWidth: number): number {
  const p = clamp01(progress);
  if (p <= 0) return 0;
  return Math.max(1, Math.round(fullWidth * p));
}

export function panePhaseComplete(
  phase: PaneAnimPhase,
  ageMs: number,
  enterMs: number = PLAN_PANE_ENTER_MS,
  exitMs: number = PLAN_PANE_EXIT_MS,
): PaneAnimPhase | null {
  const age = Math.max(0, ageMs);
  if (phase === "enter" && age >= enterMs) return "open";
  if (phase === "exit" && age >= exitMs) return "closed";
  return null;
}
