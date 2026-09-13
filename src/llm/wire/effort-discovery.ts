import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ChatMessage,
  CompletionRequestPurpose,
  ProviderId,
  ReasoningEffort,
  ReasoningPreference,
} from "../../types.js";
import {
  displayReasoningEfforts,
  markReasoningMandatory,
  modelSupportsThinking,
  registerPreflightEfforts,
} from "../capabilities.js";
import { currentRequestPurpose } from "../request-purpose.js";
import { withSessionAffinity } from "../session-affinity.js";
import {
  isReasoningUnsupportedError,
  reasoningRejectionAdvice,
} from "./capability-errors.js";

const DISCOVERY_TTL_MS = 30 * 60 * 1000;
const DISCOVERY_MAX_ENTRIES = 400;

export const DISCOVERY_EFFORTS: readonly ReasoningEffort[] = [
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
];

export const DISCOVERY_MESSAGES: ChatMessage[] = [
  { role: "user", content: "Reply with exactly: ok" },
];

export type EffortSender = (
  preference: ReasoningPreference | undefined,
) => Promise<unknown>;

export interface EffortDiscoveryRoute {
  providerId: ProviderId;
  model: string;
  endpoint?: string | undefined;
  discoverCapabilities?: boolean | undefined;
  probe?: boolean | undefined;
  reasoningRequested?: boolean | undefined;
}

export interface RoutableWireOptions {
  providerId: ProviderId;
  model: string;
  baseUrl: string;
  discoverCapabilities?: boolean | undefined;
  reasoningEffortProbe?: ReasoningEffort | undefined;
  reasoning?: ReasoningPreference | undefined;
}

export function discoveryRouteFor(options: RoutableWireOptions): EffortDiscoveryRoute {
  return {
    providerId: options.providerId,
    model: options.model,
    endpoint: options.baseUrl,
    discoverCapabilities: options.discoverCapabilities,
    probe: options.reasoningEffortProbe !== undefined,
    reasoningRequested: options.reasoning?.enabled === true,
  };
}

export function effortProbePreference(
  preference: ReasoningPreference | undefined,
): ReasoningEffort | undefined {
  return preference?.enabled ? preference.effort : undefined;
}

const discoveries = new Map<string, number>();
const pending = new Map<string, Promise<void>>();
const unknownVocabulary = new Set<string>();
const disableAccepted = new Set<string>();
const discoveryScope = new AsyncLocalStorage<boolean>();
let discoveryEnabled = true;

export function setEffortDiscoveryEnabledForTesting(enabled: boolean): void {
  discoveryEnabled = enabled;
}

function cacheKey(route: EffortDiscoveryRoute): string {
  const endpoint = (route.endpoint ?? "").replace(/\/+$/, "");
  return `${route.providerId}|${endpoint}|${route.model}`;
}

function knowledgeKey(providerId: ProviderId, model: string): string {
  return `${providerId}|${model}`;
}

export function routeVocabularyKnown(
  providerId: ProviderId,
  model: string,
): boolean {
  const efforts = displayReasoningEfforts(providerId, model);
  return Boolean(efforts && efforts.length > 0);
}

export function effortDiscoveryApplies(route: EffortDiscoveryRoute): boolean {
  if (!discoveryEnabled) return false;
  if (discoveryScope.getStore() === true) return false;
  if (route.probe === true) return false;
  if (route.reasoningRequested !== true) return false;
  if (route.discoverCapabilities === false) return false;
  if (route.discoverCapabilities === true) return true;
  return (
    modelSupportsThinking(route.providerId, route.model) &&
    !routeVocabularyKnown(route.providerId, route.model)
  );
}

async function probeSenderLadder(
  sender: EffortSender,
  signal: AbortSignal | undefined,
): Promise<ReasoningEffort[] | undefined> {
  const accepted: ReasoningEffort[] = [];
  for (const effort of DISCOVERY_EFFORTS) {
    if (signal?.aborted) return undefined;
    try {
      await sender({ enabled: true, effort });
      accepted.push(effort);
    } catch (error) {
      if (isReasoningUnsupportedError(error)) continue;
      return undefined;
    }
  }
  return accepted;
}

async function probeDisable(
  sender: EffortSender,
  route: EffortDiscoveryRoute,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  try {
    await sender({ enabled: false, effort: "none" });
    return true;
  } catch (error) {
    if (signal?.aborted) return false;
    if (reasoningRejectionAdvice(error)?.mandatory === true) {
      markReasoningMandatory(route.providerId, route.model);
    }
    return false;
  }
}

const EFFORT_ORDER: readonly ReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function unionEfforts(
  results: readonly (readonly ReasoningEffort[])[],
): ReasoningEffort[] {
  const accepted = new Set(results.flat());
  return EFFORT_ORDER.filter((effort) => accepted.has(effort));
}

function remember(
  route: EffortDiscoveryRoute,
  key: string,
  wasUnknown: boolean,
  disable: boolean,
): void {
  discoveries.delete(key);
  discoveries.set(key, Date.now() + DISCOVERY_TTL_MS);
  while (discoveries.size > DISCOVERY_MAX_ENTRIES) {
    discoveries.delete(discoveries.keys().next().value!);
  }
  const knowledge = knowledgeKey(route.providerId, route.model);
  if (wasUnknown) unknownVocabulary.add(knowledge);
  if (disable) disableAccepted.add(knowledge);
}

async function runDiscovery(
  route: EffortDiscoveryRoute,
  senders: readonly EffortSender[],
  signal: AbortSignal | undefined,
  key: string,
): Promise<void> {
  const results: ReasoningEffort[][] = [];
  for (const sender of senders) {
    const accepted = await probeSenderLadder(sender, signal);
    if (!accepted) return;
    results.push(accepted);
  }
  const wasUnknown = !routeVocabularyKnown(route.providerId, route.model);
  registerPreflightEfforts(
    route.providerId,
    route.model,
    unionEfforts(results),
  );
  let disable = true;
  for (const sender of senders) {
    disable = (await probeDisable(sender, route, signal)) && disable;
  }
  remember(route, key, wasUnknown, disable);
}

export async function discoverRouteEfforts(
  route: EffortDiscoveryRoute,
  senders: readonly EffortSender[],
  signal?: AbortSignal,
): Promise<void> {
  if (senders.length === 0) return;
  if (!effortDiscoveryApplies(route)) return;
  const key = cacheKey(route);
  const expiresAt = discoveries.get(key);
  if (expiresAt !== undefined && expiresAt > Date.now()) return;
  const inFlight = pending.get(key);
  if (inFlight) {
    await inFlight.catch(() => {});
    return;
  }
  const task = discoveryScope.run(true, () =>
    withSessionAffinity(`preflight-${key}`, () =>
      runDiscovery(route, senders, signal, key).catch(() => {}),
    ),
  );
  pending.set(key, task);
  try {
    await task;
  } finally {
    if (pending.get(key) === task) pending.delete(key);
  }
}

export function routeDisableAccepted(
  providerId: ProviderId,
  model: string,
): boolean {
  return disableAccepted.has(knowledgeKey(providerId, model));
}

export function resolveEffortForPurpose(
  providerId: ProviderId,
  model: string,
  purpose: CompletionRequestPurpose | undefined,
): ReasoningPreference | undefined {
  const efforts = displayReasoningEfforts(providerId, model)?.filter(
    (effort) => effort !== "none",
  );
  if (!efforts || efforts.length === 0) return undefined;
  if (purpose === undefined) return undefined;
  if (purpose === "turn") {
    return { enabled: true, effort: efforts[efforts.length - 1] as ReasoningEffort };
  }
  if (routeDisableAccepted(providerId, model)) {
    return { enabled: false, effort: "none" };
  }
  return { enabled: true, effort: efforts[0] as ReasoningEffort };
}

export interface ReasoningRequestShape {
  providerId?: ProviderId | undefined;
  model: string;
  reasoning?: ReasoningPreference | undefined;
  purpose?: CompletionRequestPurpose | undefined;
  reasoningEffortProbe?: ReasoningEffort | undefined;
}

export function applyDiscoveredReasoning<T extends ReasoningRequestShape>(
  options: T,
): T {
  const { providerId, model } = options;
  if (providerId === undefined || options.reasoningEffortProbe !== undefined) {
    return options;
  }
  if (!unknownVocabulary.has(knowledgeKey(providerId, model))) return options;
  const resolved = resolveEffortForPurpose(
    providerId,
    model,
    options.purpose ?? currentRequestPurpose(),
  );
  if (!resolved) return options;
  return { ...options, reasoning: resolved };
}

export function resetEffortDiscovery(): void {
  discoveries.clear();
  pending.clear();
  unknownVocabulary.clear();
  disableAccepted.clear();
}
