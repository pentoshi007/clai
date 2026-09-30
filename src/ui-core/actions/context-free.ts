import type { ActionId } from "./action-id.js";
import type { ActionRouter } from "./action-router.js";

const CONTEXT_FREE_ACTIONS: ReadonlySet<ActionId> = new Set<ActionId>(["app.redraw"]);

export function resolveContextFreeAction(
  router: ActionRouter,
  chord: string,
): ActionId | undefined {
  const action = router.resolve(chord, "global");
  return action !== undefined && CONTEXT_FREE_ACTIONS.has(action) ? action : undefined;
}
