
import { useSyncExternalStore } from "react";
import type { PlanController } from "../../app/controllers/plan-controller.js";
import type { SessionPlan } from "../../store/plan.js";

export function usePlan(controller: PlanController): SessionPlan | undefined {
  return useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.current(),
  );
}
