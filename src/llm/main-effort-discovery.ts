import { AsyncLocalStorage } from "node:async_hooks";
import type { ProviderId, ReasoningEffort } from "../types.js";
import type { ReasoningControlDialect } from "./provider-profile.js";
import { WIRE_EFFORT_SCALE } from "./reasoning-controls.js";
import { currentIsolatedSessionAffinity } from "./session-affinity.js";

interface MainEffortKnowledge {
  accepted: Set<ReasoningEffort>;
  outcomes: Map<ReasoningEffort, ReasoningEffort>;
}

interface MainEffortProbe {
  provider: ProviderId;
  model: string;
  effort: ReasoningEffort;
}

const knowledge = new Map<string, MainEffortKnowledge>();
const probes = new AsyncLocalStorage<MainEffortProbe>();
const EFFORT_DIALECTS: ReadonlySet<ReasoningControlDialect> = new Set([
  "openai-effort",
  "openai-nested-reasoning",
  "meta-reasoning-effort",
  "modal-advertised-effort",
  "deepseek-thinking",
]);

function routeKey(provider: ProviderId, model: string): string {
  return `${currentIsolatedSessionAffinity() ?? "shared"}:${provider}:${model.trim().toLowerCase()}`;
}

export function isEffortControlDialect(dialect: ReasoningControlDialect): boolean {
  return EFFORT_DIALECTS.has(dialect);
}

export function withMainEffortProbe<T>(probe: MainEffortProbe, run: () => T): T {
  return probes.run(probe, run);
}

export function mainEffortProbe(provider: string, model: string): ReasoningEffort | undefined {
  const probe = probes.getStore();
  return probe?.provider === provider && probe.model.toLowerCase() === model.toLowerCase()
    ? probe.effort : undefined;
}

export function hasMainEffortKnowledge(provider: ProviderId, model: string): boolean {
  return knowledge.has(routeKey(provider, model));
}

export function resolvedMainEffort(
  provider: ProviderId,
  model: string,
  requested: ReasoningEffort,
): ReasoningEffort | undefined {
  const known = knowledge.get(routeKey(provider, model));
  if (!known) return undefined;
  if (known.accepted.has(requested)) return requested;
  const outcome = known.outcomes.get(requested);
  if (outcome) return outcome;
  const ceiling = [...WIRE_EFFORT_SCALE].reverse().find((effort) => known.accepted.has(effort));
  return ceiling && WIRE_EFFORT_SCALE.indexOf(requested) >= WIRE_EFFORT_SCALE.indexOf(ceiling)
    ? ceiling : undefined;
}

export function rememberMainEffort(
  provider: ProviderId,
  model: string,
  requested: ReasoningEffort,
  accepted: ReasoningEffort,
  advertised: readonly string[] = [],
): readonly ReasoningEffort[] {
  const key = routeKey(provider, model);
  const known = knowledge.get(key) ?? { accepted: new Set<ReasoningEffort>(), outcomes: new Map<ReasoningEffort, ReasoningEffort>() };
  known.accepted.add(accepted);
  for (const effort of WIRE_EFFORT_SCALE) {
    if (advertised.includes(effort)) known.accepted.add(effort);
  }
  known.outcomes.set(requested, accepted);
  knowledge.delete(key);
  knowledge.set(key, known);
  while (knowledge.size > 512) knowledge.delete(knowledge.keys().next().value!);
  return WIRE_EFFORT_SCALE.filter((effort) => known.accepted.has(effort));
}

export function forgetMainEffort(provider: ProviderId, model: string, rejected: ReasoningEffort): void {
  const known = knowledge.get(routeKey(provider, model));
  if (!known) return;
  known.accepted.delete(rejected);
  for (const [requested, accepted] of known.outcomes) {
    if (accepted === rejected) known.outcomes.delete(requested);
  }
}

export function resetMainEffortKnowledge(): void {
  knowledge.clear();
}
