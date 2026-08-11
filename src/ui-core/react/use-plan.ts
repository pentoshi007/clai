/** React binding for `PlanController` (V2-070), mirroring `use-transcript-store.ts`. */

import { useSyncExternalStore } from "react";
import type { PlanController } from "../../app/controllers/plan-controller.js";
import type { SessionPlan } from "../../store/plan.js";

export function usePlan(controller: PlanController): SessionPlan | undefined {
  return useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.current(),
  );
}
