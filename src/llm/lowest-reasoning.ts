import type {
  CompletionRequest,
  ProviderId,
  ReasoningPreference,
} from "../types.js";
import { EFFORT_SCALE } from "./reasoning-controls.js";
import {
  displayReasoningEfforts,
  learnedRouteEfforts,
} from "./capabilities.js";
import { routeDisableAccepted } from "./wire/effort-discovery.js";
import { resolveBuiltInProfile } from "./provider-profiles.js";

export function lowestReasoningPreference(
  provider: ProviderId,
  model: string,
): ReasoningPreference {
  const { reasoning } = resolveBuiltInProfile({ provider, model });
  const learned = learnedRouteEfforts(provider, model);
  const declared = displayReasoningEfforts(provider, model);
  let accepted = reasoning.acceptedEfforts;
  if (declared?.length) accepted = declared;
  if (learned?.length) accepted = learned;
  const disableByOmission =
    reasoning.disableForm === undefined ||
    reasoning.disableForm === "omit-control";
  const disableAllowed =
    reasoning.generation !== "mandatory" &&
    reasoning.disable === "supported" &&
    (disableByOmission ||
      accepted.length === 0 ||
      accepted.includes("none") ||
      routeDisableAccepted(provider, model));
  if (reasoning.control.status === "unsupported" || disableAllowed) {
    return { enabled: false, effort: "none" };
  }
  const selectable =
    reasoning.generation === "mandatory"
      ? accepted.filter((effort) => effort !== "none")
      : accepted;
  const least = EFFORT_SCALE.find((effort) => selectable.includes(effort));
  const effort =
    least ?? (reasoning.generation === "mandatory" ? "minimal" : "none");
  return { enabled: effort !== "none", effort };
}

export function withLowestReasoning(
  request: CompletionRequest,
  provider: ProviderId,
  model: string,
): CompletionRequest {
  return { ...request, thinking: lowestReasoningPreference(provider, model) };
}
