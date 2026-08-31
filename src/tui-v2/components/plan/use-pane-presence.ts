
import type { PaneAnimState } from "./plan-pane-anim.js";

export function usePanePresence(open: boolean): PaneAnimState {
  return {
    phase: open ? "open" : "closed",
    progress: open ? 1 : 0,
    mounted: open,
  };
}
