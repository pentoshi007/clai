import type {
  ChatMessage,
  CompletionRequestPurpose,
  ProviderId,
  ReasoningEffort,
} from "../../types.js";
import {
  displayReasoningEfforts,
  isReasoningUnsupported,
  learnModelReasoningSupport,
  markReasoningUnsupported,
  modelCatalogFacts,
  modelSupportsThinking,
  modelReasoningEfforts,
  registerWireRejectionEfforts,
  scopedRuntimeReasoningEffortsKnown,
} from "../capabilities.js";
import { WIRE_EFFORT_SCALE } from "../reasoning-controls.js";
import { catalogEffortList } from "../catalog-facts.js";
import { resolveBuiltInProfile } from "../provider-profiles.js";
import {
  hasMainEffortKnowledge,
  isEffortControlDialect,
  rememberMainEffort,
  resetMainEffortKnowledge,
  resolvedMainEffort,
} from "../main-effort-discovery.js";
import { currentSessionAffinity } from "../session-affinity.js";

export const PREFLIGHT_MESSAGES: ChatMessage[] = [
  { role: "user", content: "Reply with exactly: ok" },
];

export const PREFLIGHT_MAX_TOKENS = 16;

export type EffortProbeOutcome = "accepted" | "unsupported" | "abort" |
  { readonly acceptedEfforts: readonly string[] };

export interface EffortPreflightRoute {
  providerId: ProviderId;
  model: string;
  endpoint?: string | undefined;
  requested: ReasoningEffort;
  purpose?: CompletionRequestPurpose | undefined;
  rejectedEffort?: ReasoningEffort | undefined;
}

const SUBAGENT_ORDER: readonly ReasoningEffort[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const TURN_ORDER: readonly ReasoningEffort[] = [...WIRE_EFFORT_SCALE].reverse();

const MAX_PROBED_KEYS = 400;

const EFFORT_RANK = new Map<string, number>(
  WIRE_EFFORT_SCALE.map((effort, index) => [effort, index]),
);

const probedKeys = new Set<string>();

const pendingProbes = new Map<string, Promise<ReasoningEffort | undefined>>();

const probeOutcomes = new Map<string, ReasoningEffort | undefined>();

function rankOf(effort: ReasoningEffort): number {
  return EFFORT_RANK.get(effort) ?? -1;
}

function isSubagentProbe(route: EffortPreflightRoute): boolean {
  return route.purpose === undefined;
}

export function effortPreflightKey(route: EffortPreflightRoute): string {
  const endpoint = (route.endpoint ?? "").replace(/\/+$/, "");
  return [
    currentSessionAffinity() ?? "shared",
    route.providerId,
    endpoint,
    route.model,
    route.requested,
    route.purpose ?? "subagent",
  ].join("|");
}

export function needsEffortPreflight(route: EffortPreflightRoute): boolean {
  if (route.purpose === "compaction" || route.purpose === "auxiliary") {
    return false;
  }
  const key = effortPreflightKey(route);
  const scopedKnown = isSubagentProbe(route)
    ? scopedRuntimeReasoningEffortsKnown(route.providerId, route.model)
    : undefined;
  if (scopedKnown !== undefined && probeOutcomes.has(key)) {
    return probeOutcomes.get(key) !== undefined && !scopedKnown;
  }
  if (!route.rejectedEffort && probedKeys.has(key)) return false;
  if (isReasoningUnsupported(route.providerId, route.model)) return false;
  if (route.providerId === "meta" && displayReasoningEfforts(route.providerId, route.model)?.length === 0) return false;
  if (!isSubagentProbe(route)) {
    const { providerId, model, requested } = route;
    const profile = resolveBuiltInProfile({ provider: providerId, model });
    if (!isEffortControlDialect(profile.reasoning.control.dialect)) return false;
    if (modelCatalogFacts(providerId, model)?.reasoning?.supported === false) return false;
    if (route.rejectedEffort) return true;
    if (catalogEffortList(modelCatalogFacts(providerId, model)?.reasoning?.supportedEfforts)?.length) return false;
    if (hasMainEffortKnowledge(providerId, model)) {
      return resolvedMainEffort(providerId, model, requested) === undefined;
    }
  } else if (!modelSupportsThinking(route.providerId, route.model)) return false;
  if (
    route.providerId === "cline" &&
    modelCatalogFacts("cline", route.model)?.reasoning?.supported !== undefined
  ) return false;
  return !displayReasoningEfforts(route.providerId, route.model)?.length;
}

function probeOrder(route: EffortPreflightRoute): readonly ReasoningEffort[] {
  if (isSubagentProbe(route)) return SUBAGENT_ORDER;
  if (route.rejectedEffort) {
    const declared = hasMainEffortKnowledge(route.providerId, route.model)
      ? undefined : modelReasoningEfforts(route.providerId, route.model);
    return TURN_ORDER.filter((effort) =>
      rankOf(effort) < rankOf(route.rejectedEffort!) && (!declared?.length || declared.includes(effort)),
    );
  }
  if (route.requested === "none") return ["none"];
  return hasMainEffortKnowledge(route.providerId, route.model)
    ? TURN_ORDER.filter((effort) => rankOf(effort) <= rankOf(route.requested))
    : TURN_ORDER;
}

function settleProbedEfforts(
  route: EffortPreflightRoute,
  accepted: ReasoningEffort,
): void {
  const index = rankOf(accepted);
  if (index < 0) return;
  const observed = isSubagentProbe(route)
    ? WIRE_EFFORT_SCALE.slice(index)
    : rememberMainEffort(route.providerId, route.model, route.requested, accepted);
  registerWireRejectionEfforts(route.providerId, route.model, observed);
  if (accepted !== "none") {
    learnModelReasoningSupport(route.providerId, route.model);
  }
}

function rememberProbeOutcome(
  key: string,
  outcome: ReasoningEffort | undefined,
): void {
  probedKeys.delete(key);
  probedKeys.add(key);
  probeOutcomes.delete(key);
  probeOutcomes.set(key, outcome);
  while (probedKeys.size > MAX_PROBED_KEYS) {
    const oldest = probedKeys.keys().next().value!;
    probedKeys.delete(oldest);
    probeOutcomes.delete(oldest);
  }
}

async function probeEffortLadder(
  route: EffortPreflightRoute,
  probe: (effort: ReasoningEffort) => Promise<EffortProbeOutcome>,
  key: string,
): Promise<ReasoningEffort | undefined> {
  let accepted: ReasoningEffort | undefined;
  let exhausted = true;
  for (const effort of probeOrder(route)) {
    const outcome = await probe(effort);
    if (typeof outcome === "object" && !isSubagentProbe(route)) {
      accepted = probeOrder(route).find((candidate) =>
        rankOf(candidate) < rankOf(effort) && outcome.acceptedEfforts.includes(candidate),
      );
      if (accepted) rememberMainEffort(route.providerId, route.model, route.requested, accepted, outcome.acceptedEfforts);
      exhausted = false;
      break;
    }
    if (outcome === "abort") {
      exhausted = false;
      break;
    }
    if (outcome === "accepted") {
      accepted = effort;
      break;
    }
  }
  if (exhausted && !accepted && !isSubagentProbe(route)) {
    markReasoningUnsupported(route.providerId, route.model);
  }
  rememberProbeOutcome(key, accepted);
  return accepted;
}

export async function runEffortPreflight(
  route: EffortPreflightRoute,
  probe: (effort: ReasoningEffort) => Promise<EffortProbeOutcome>,
): Promise<void> {
  if (!needsEffortPreflight(route)) return;
  const key = effortPreflightKey(route);
  const scopedKnown = isSubagentProbe(route)
    ? scopedRuntimeReasoningEffortsKnown(route.providerId, route.model)
    : undefined;
  if (scopedKnown !== undefined && probeOutcomes.has(key)) {
    const accepted = probeOutcomes.get(key);
    if (accepted && !scopedKnown) settleProbedEfforts(route, accepted);
    return;
  }
  const pending = pendingProbes.get(key);
  if (pending) {
    await pending;
    const accepted = probeOutcomes.get(key);
    if (scopedKnown !== undefined && accepted && !scopedKnown) {
      settleProbedEfforts(route, accepted);
    }
    return;
  }
  const run = Promise.resolve().then(() => probeEffortLadder(route, probe, key));
  pendingProbes.set(key, run);
  try {
    const accepted = await run;
    if (accepted) settleProbedEfforts(route, accepted);
  } finally {
    if (pendingProbes.get(key) === run) pendingProbes.delete(key);
  }
}

export function resetEffortPreflightForTesting(): void {
  resetMainEffortKnowledge();
  probedKeys.clear();
  probeOutcomes.clear();
  pendingProbes.clear();
}
