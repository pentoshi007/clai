import type {
  CompletionRequest,
  ProviderId,
  ReasoningPreference,
} from "../types.js";
import { EFFORT_SCALE } from "./reasoning-controls.js";
import { learnedRouteEfforts } from "./capabilities.js";
import { resolveBuiltInProfile } from "./provider-profiles.js";

export function lowestReasoningPreference(
  provider: ProviderId,
  model: string,
): ReasoningPreference {
  const { reasoning } = resolveBuiltInProfile({ provider, model });
  const learned = learnedRouteEfforts(provider, model);
  if (
    reasoning.control.status === "unsupported" ||
    (reasoning.generation !== "mandatory" &&
      reasoning.disable === "supported" &&
      (!learned?.length || learned.includes("none")))
  ) {
    return { enabled: false, effort: "none" };
  }
  const effort = EFFORT_SCALE.find(
    (candidate) =>
      (candidate !== "none" || reasoning.generation !== "mandatory") &&
      reasoning.acceptedEfforts.includes(candidate),
  ) ?? (reasoning.generation === "mandatory" ? "minimal" : "none");
  return { enabled: effort !== "none", effort };
}

export function withLowestReasoning(
  request: CompletionRequest,
  provider: ProviderId,
  model: string,
): CompletionRequest {
  return { ...request, thinking: lowestReasoningPreference(provider, model) };
}
