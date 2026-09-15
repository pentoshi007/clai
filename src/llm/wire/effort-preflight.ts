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
  modelSupportsThinking,
  registerWireRejectionEfforts,
  scopedRuntimeReasoningEffortsKnown,
} from "../capabilities.js";
import { EFFORT_SCALE } from "../reasoning-controls.js";
import { currentSessionAffinity } from "../session-affinity.js";

export const PREFLIGHT_MESSAGES: ChatMessage[] = [
  { role: "user", content: "Reply with exactly: ok" },
];

export const PREFLIGHT_MAX_TOKENS = 16;

export type EffortProbeOutcome = "accepted" | "unsupported" | "abort";

export interface EffortPreflightRoute {
  providerId: ProviderId;
  model: string;
  endpoint?: string | undefined;
  requested: ReasoningEffort;
  purpose?: CompletionRequestPurpose | undefined;
}

const SUBAGENT_ORDER: readonly ReasoningEffort[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const TURN_ORDER: readonly ReasoningEffort[] = [...EFFORT_SCALE].reverse();

const MAX_PROBED_KEYS = 400;

const EFFORT_RANK = new Map<string, number>(
  EFFORT_SCALE.map((effort, index) => [effort, index]),
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

function preflightSession(route: EffortPreflightRoute): string {
  const affinity = currentSessionAffinity() ?? "shared";
  return isSubagentProbe(route) ? affinity.split(":subagent:")[0]! : affinity;
}

export function effortPreflightKey(route: EffortPreflightRoute): string {
  const endpoint = (route.endpoint ?? "").replace(/\/+$/, "");
  return [
    preflightSession(route),
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
  if (probedKeys.has(key)) return false;
  if (isReasoningUnsupported(route.providerId, route.model)) return false;
  if (!modelSupportsThinking(route.providerId, route.model)) return false;
  return !displayReasoningEfforts(route.providerId, route.model)?.length;
}

function probeOrder(route: EffortPreflightRoute): readonly ReasoningEffort[] {
  return isSubagentProbe(route) ? SUBAGENT_ORDER : TURN_ORDER;
}

function settleProbedEfforts(
  route: EffortPreflightRoute,
  accepted: ReasoningEffort,
): void {
  const index = rankOf(accepted);
  if (index < 0) return;
  const observed = isSubagentProbe(route)
    ? EFFORT_SCALE.slice(index)
    : EFFORT_SCALE.slice(0, index + 1);
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
  for (const effort of probeOrder(route)) {
    const outcome = await probe(effort);
    if (outcome === "abort") break;
    if (outcome === "accepted") {
      accepted = effort;
      break;
    }
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
  probedKeys.clear();
  probeOutcomes.clear();
  pendingProbes.clear();
}
