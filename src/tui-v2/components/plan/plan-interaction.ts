import type { ActionId } from "../../../ui-core/actions/action-id.js";
import { ActionRouter } from "../../../ui-core/actions/action-router.js";
import { defaultKeymap, type KeyBinding } from "../../../ui-core/actions/keymap.js";

export interface PlanInteractionPort {
  moveSelection(delta: number): void;
  setSelectedExpanded(expanded?: boolean): void;
  setAllExpanded(expanded: boolean): void;
  page(delta: number): void;
}

const PLAN_BINDINGS: readonly KeyBinding[] = [
  { chord: "down", action: "plan.next-task", context: "plan" },
  { chord: "up", action: "plan.prev-task", context: "plan" },
  { chord: "enter", action: "plan.toggle-task", context: "plan" },
  { chord: "right", action: "plan.expand-task", context: "plan" },
  { chord: "left", action: "plan.collapse-task", context: "plan" },
  { chord: "e", action: "plan.expand-all", context: "plan" },
  { chord: "c", action: "plan.collapse-all", context: "plan" },
  { chord: "pageup", action: "plan.page-up", context: "plan" },
  { chord: "pagedown", action: "plan.page-down", context: "plan" },
];

export const OPEN_TUI_KEYMAP: readonly KeyBinding[] = [
  ...defaultKeymap.filter((binding) => binding.context !== "plan"),
  ...PLAN_BINDINGS,
];

const planRouter = new ActionRouter(PLAN_BINDINGS);

export function resolvePlanInteraction(chord: string): ActionId | undefined {
  return planRouter.resolve(chord, "plan");
}

export function handlePlanInteraction(action: ActionId, port: PlanInteractionPort | null): boolean {
  if (!port) return false;
  switch (action) {
    case "plan.next-task": port.moveSelection(1); return true;
    case "plan.prev-task": port.moveSelection(-1); return true;
    case "plan.toggle-task": port.setSelectedExpanded(); return true;
    case "plan.expand-task": port.setSelectedExpanded(true); return true;
    case "plan.collapse-task": port.setSelectedExpanded(false); return true;
    case "plan.expand-all": port.setAllExpanded(true); return true;
    case "plan.collapse-all": port.setAllExpanded(false); return true;
    case "plan.page-up": port.page(-1); return true;
    case "plan.page-down": port.page(1); return true;
    default: return false;
  }
}
