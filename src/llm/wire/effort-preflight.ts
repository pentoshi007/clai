import type {
  ChatMessage,
  CompletionRequestPurpose,
  ProviderId,
  ReasoningEffort,
} from "../../types.js";
import {
  displayReasoningEfforts,
  isReasoningUnsupported,
  modelSupportsThinking,
  registerModelReasoningSupport,
  registerWireRejectionEfforts,
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

const pendingProbes = new Map<string, Promise<void>>();

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
  if (probedKeys.has(effortPreflightKey(route))) return false;
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
    registerModelReasoningSupport(route.providerId, route.model, true);
  }
}

function rememberKey(key: string): void {
  probedKeys.delete(key);
  probedKeys.add(key);
  while (probedKeys.size > MAX_PROBED_KEYS) {
    probedKeys.delete(probedKeys.keys().next().value!);
  }
}

async function probeEffortLadder(
  route: EffortPreflightRoute,
  probe: (effort: ReasoningEffort) => Promise<EffortProbeOutcome>,
  key: string,
): Promise<void> {
  let accepted: ReasoningEffort | undefined;
  for (const effort of probeOrder(route)) {
    const outcome = await probe(effort);
    if (outcome === "abort") break;
    if (outcome === "accepted") {
      accepted = effort;
      break;
    }
  }
  rememberKey(key);
  if (accepted) settleProbedEfforts(route, accepted);
}

export async function runEffortPreflight(
  route: EffortPreflightRoute,
  probe: (effort: ReasoningEffort) => Promise<EffortProbeOutcome>,
): Promise<void> {
  if (!needsEffortPreflight(route)) return;
  const key = effortPreflightKey(route);
  const pending = pendingProbes.get(key);
  if (pending) return pending;
  const run = Promise.resolve().then(() => probeEffortLadder(route, probe, key));
  pendingProbes.set(key, run);
  try {
    await run;
  } finally {
    if (pendingProbes.get(key) === run) pendingProbes.delete(key);
  }
}

export function resetEffortPreflightForTesting(): void {
  probedKeys.clear();
  pendingProbes.clear();
}
