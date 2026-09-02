import type { ToolCall } from "../../../types.js";
import type { EngagementScope } from "../../../store/scope.js";
import type { EngagementAction } from "../../../safety/engagement-policy.js";
import { outOfScopeToolMessage } from "../../scope-context.js";
import { evaluateEngagementAction } from "../../../safety/engagement-policy.js";
import {
  beginEngagementAction,
  openEngagement,
  saveEngagement,
  type EngagementActionRecord,
  type EngagementGraph,
} from "../../../store/engagement.js";

export interface EngagementGatePorts {
  readonly scope: EngagementScope | undefined;
  readonly audit: (
    event: string,
    payload: Readonly<Record<string, string | boolean | undefined>>,
  ) => Promise<void>;
}

export interface EngagementGateOutcome {
  readonly blockedReason: string | undefined;
  readonly decision: ReturnType<typeof evaluateEngagementAction> | undefined;
  readonly graph: EngagementGraph | undefined;
  readonly record: EngagementActionRecord | undefined;
}

export const evaluateEngagementGate = async (
  ports: EngagementGatePorts,
  call: ToolCall,
  actions: readonly EngagementAction[],
  scopeTarget: string | undefined,
): Promise<EngagementGateOutcome> => {
  const primary = actions[0];
  let decision: ReturnType<typeof evaluateEngagementAction> | undefined;
  let graph: EngagementGraph | undefined;
  let record: EngagementActionRecord | undefined;

  for (const action of actions) {
    const actionDecision = evaluateEngagementAction(ports.scope, action);
    if (!actionDecision) continue;
    if (action === primary) decision = actionDecision;
    if (ports.scope) {
      graph = await openEngagement(ports.scope);
      record = beginEngagementAction(graph, {
        tool: call.name,
        target: actionDecision.normalizedTarget || action.target,
        phase: actionDecision.phase,
        capability: actionDecision.capability,
        authorized: actionDecision.allowed,
        reason: actionDecision.reason,
      });
      await saveEngagement(graph);
    }
    await ports.audit("engagement.policy", {
      ...(graph ? { engagementId: graph.id } : {}),
      ...(record ? { actionId: record.id } : {}),
      tool: call.name,
      target: actionDecision.normalizedTarget,
      phase: actionDecision.phase,
      capability: actionDecision.capability,
      allowed: actionDecision.allowed,
      reason: actionDecision.reason,
    });
    if (actionDecision.allowed) continue;
    return {
      blockedReason: outOfScopeToolMessage({
        target:
          actionDecision.normalizedTarget ||
          action.target ||
          scopeTarget ||
          "requested target",
        reason: actionDecision.reason,
        allowed: ports.scope?.authorizedTargets,
      }),
      decision,
      graph,
      record,
    };
  }

  return { blockedReason: undefined, decision, graph, record };
};
