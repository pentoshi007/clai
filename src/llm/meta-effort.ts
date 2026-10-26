import { documentedMetaReasoning } from "./meta-models.js";
import { EFFORT_SCALE, nearestAcceptedEffort } from "./reasoning-controls.js";

export function metaSupportsMaxEffort(model: string): boolean {
  return metaAcceptedEfforts(model).includes("max");
}

export function metaAcceptedEfforts(model: string): readonly string[] {
  const efforts = documentedMetaReasoning(model)?.supportedEfforts;
  return Array.isArray(efforts) ? efforts : [];
}

export function metaReasoningEffort(
  effort: string,
  model: string,
  accepted?: readonly string[],
): string | undefined {
  const normalized = effort.trim().toLowerCase();
  const requested = EFFORT_SCALE.find((value) => value === normalized) ?? "medium";
  const documented = documentedMetaReasoning(model);
  const efforts = accepted ?? (documented ? metaAcceptedEfforts(model) : undefined);
  if (efforts) return nearestAcceptedEffort(requested, efforts);
  return requested === "none" ? "minimal" : requested;
}

export function metaReasoningSummary(effort: string): string {
  if (effort === "max" || effort === "xhigh" || effort === "high") {
    return "detailed";
  }
  if (effort === "medium") return "concise";
  return "auto";
}
