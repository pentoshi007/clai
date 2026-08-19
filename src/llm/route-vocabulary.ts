import type { ProviderId } from "../types.js";
import { getProviderModel } from "../store/config.js";
import {
  registerModelReasoningSupport,
  registerRouteAcceptedEfforts,
  registerRouteControlDialect,
} from "./capabilities.js";
import { isBuiltInProviderId } from "./provider-profile.js";
import { resolveBuiltInProfile } from "./provider-profiles.js";

export function publishRouteReasoningVocabulary(
  provider: ProviderId | undefined,
  model: string | undefined,
): void {
  if (!provider || !isBuiltInProviderId(provider)) return;
  const resolved = model?.trim() ? model : getProviderModel(provider);
  if (!resolved?.trim()) return;
  const profile = resolveBuiltInProfile({ provider, model: resolved });
  registerRouteAcceptedEfforts(provider, resolved, profile.reasoning.acceptedEfforts);
  registerRouteControlDialect(provider, resolved, profile.reasoning.control.dialect);
  const status = profile.reasoning.control.status;
  const generation = profile.reasoning.generation;
  if (status === "supported" || generation === "default-on" || generation === "mandatory") {
    registerModelReasoningSupport(provider, resolved, true);
  } else if (status === "unsupported" || generation === "none") {
    registerModelReasoningSupport(provider, resolved, false);
  }
}
