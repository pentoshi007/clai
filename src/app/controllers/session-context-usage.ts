import { estimateMessagesTokens } from "../../agent/context-manager.js";
import { resolveEffectiveContextLimit } from "../../agent/request-accounting.js";
import { calibratedRequestTokens } from "../../llm/token-estimate-calibration.js";
import {
  contextLimitFromSessionOverride,
  contextSnapshotFromLegacy,
  createContextSnapshot,
  isContextSnapshotV1,
  toLegacyContextUsage,
  withContextSnapshotLimit,
  type ContextAttemptReference,
  type ContextSnapshotCache,
  type ContextSnapshotLimit,
  type ContextSnapshotReasoning,
  type ContextSnapshotScope,
  type ContextSnapshotV1,
} from "../../llm/context-snapshot.js";
import type { ContextUsageSnapshot } from "../../llm/token-usage.js";
import type { ChatMessage, ProviderId, TokenUsage } from "../../types.js";

export interface ContextUsageTarget {
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
  readonly contextLimitTokens?: number | undefined;
}

export type ContextClock = () => number;
const systemNow: ContextClock = () => Date.now();

export function contextUsageLimit(target: ContextUsageTarget): number {
  const limit = target.contextLimitTokens;
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : 0;
}

function limitFor(target: ContextUsageTarget): ContextSnapshotLimit {
  return contextLimitFromSessionOverride(contextUsageLimit(target));
}

function sameLimit(
  left: ContextSnapshotLimit,
  right: ContextSnapshotLimit,
): boolean {
  return left.source === right.source && left.tokens === right.tokens;
}

function hasPromptMeasurement(usage: TokenUsage): boolean {
  return usage.promptTokensKnown !== false;
}

function reportedCache(
  usage: TokenUsage,
): ContextSnapshotCache | undefined {
  const readTokens = usage.cachedPromptTokens;
  const creationTokens = usage.cacheCreationTokens;
  const uncachedTokens = usage.uncachedPromptTokens;
  if (
    readTokens === undefined &&
    creationTokens === undefined &&
    uncachedTokens === undefined
  ) {
    return undefined;
  }
  return {
    kind: "reported",
    ...(readTokens !== undefined ? { readTokens } : {}),
    ...(creationTokens !== undefined ? { creationTokens } : {}),
    ...(uncachedTokens !== undefined ? { uncachedTokens } : {}),
  };
}

function reportedReasoning(
  usage: TokenUsage,
): ContextSnapshotReasoning | undefined {
  if (usage.reasoningTokens === undefined) return undefined;
  return { kind: "reported", outputTokens: usage.reasoningTokens };
}

function estimateHistoryRequestTokens(
  target: ContextUsageTarget,
  history: readonly ChatMessage[],
): number {
  const raw = estimateMessagesTokens(history as ChatMessage[]);
  if (raw <= 0) return 0;
  const limit = resolveEffectiveContextLimit({
    provider: target.provider,
    model: target.model,
    ...(target.contextLimitTokens !== undefined
      ? { contextLimitTokens: target.contextLimitTokens }
      : {}),
  }).reservedOutputTokens;
  return calibratedRequestTokens(
    target.provider,
    target.model,
    raw + Math.max(0, Math.floor(limit / 4)),
  );
}

function historyEstimateSnapshot(
  target: ContextUsageTarget,
  current: ContextSnapshotV1 | undefined,
  history: readonly ChatMessage[],
  now: ContextClock,
): ContextSnapshotV1 {
  return createContextSnapshot({
    contextTokens: estimateHistoryRequestTokens(target, history),
    lastCompletionTokens: current?.lastCompletionTokens,
    sessionPromptTokens: current?.sessionPromptTokens,
    sessionCompletionTokens: current?.sessionCompletionTokens,
    scope: "message-history",
    precision: "estimate",
    limit: limitFor(target),
    observedAt: now(),
  });
}

const REQUEST_SCOPES: ReadonlySet<ContextSnapshotScope> = new Set([
  "provider-request",
  "assembled-request",
]);

export function resolveContextSnapshot(
  target: ContextUsageTarget,
  history: readonly ChatMessage[],
  current: ContextSnapshotV1 | undefined,
  now: ContextClock = systemNow,
): ContextSnapshotV1 | undefined {
  const limit = limitFor(target);
  if (current && current.contextTokens > 0 && REQUEST_SCOPES.has(current.scope)) {
    return sameLimit(current.limit, limit)
      ? current
      : withContextSnapshotLimit(current, limit);
  }
  return historyEstimateSnapshot(target, current, history, now);
}

export function recordContextUsageSnapshot(
  target: ContextUsageTarget,
  current: ContextSnapshotV1 | undefined,
  usage: TokenUsage,
  attempt: ContextAttemptReference | undefined,
  now: ContextClock = systemNow,
): ContextSnapshotV1 {
  const promptMeasured = hasPromptMeasurement(usage);
  const sessionPromptTokens =
    (current?.sessionPromptTokens ?? 0) +
    (usage.exact && promptMeasured ? usage.promptTokens : 0);
  const sessionCompletionTokens =
    (current?.sessionCompletionTokens ?? 0) +
    (usage.exact ? usage.completionTokens : 0);
  const cache = reportedCache(usage);
  const reasoning = reportedReasoning(usage);
  return createContextSnapshot({
    contextTokens: promptMeasured
      ? usage.promptTokens
      : (current?.contextTokens ?? 0),
    lastCompletionTokens: usage.completionTokens,
    sessionPromptTokens,
    sessionCompletionTokens,
    scope: promptMeasured ? "provider-request" : "unknown",
    precision:
      usage.exact && promptMeasured
        ? "provider-exact"
        : promptMeasured
          ? "estimate"
          : "unknown",
    limit: limitFor(target),
    ...(cache ? { cache } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(attempt ? { attempt } : {}),
    observedAt: now(),
  });
}

export function compactedContextSnapshot(
  target: ContextUsageTarget,
  current: ContextSnapshotV1 | undefined,
  history: readonly ChatMessage[],
  afterTokens: number | undefined,
  scope: Extract<ContextSnapshotScope, "message-history" | "assembled-request">,
  now: ContextClock = systemNow,
): ContextSnapshotV1 {
  const contextTokens =
    typeof afterTokens === "number" && Number.isFinite(afterTokens) && afterTokens > 0
      ? Math.floor(afterTokens)
      : estimateHistoryRequestTokens(target, history);
  return createContextSnapshot({
    contextTokens,
    lastCompletionTokens: 0,
    sessionPromptTokens: current?.sessionPromptTokens,
    sessionCompletionTokens: current?.sessionCompletionTokens,
    scope,
    precision: "estimate",
    limit: limitFor(target),
    observedAt: now(),
  });
}

export function estimatedContextSnapshot(
  target: ContextUsageTarget,
  current: ContextSnapshotV1 | undefined,
  estimatedTokens: number,
  now: ContextClock = systemNow,
): ContextSnapshotV1 | undefined {
  if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) return current;
  if (current && current.contextTokens > 0 && current.scope === "provider-request") {
    return sameLimit(current.limit, limitFor(target))
      ? current
      : withContextSnapshotLimit(current, limitFor(target));
  }
  return createContextSnapshot({
    contextTokens: Math.floor(estimatedTokens),
    lastCompletionTokens: current?.lastCompletionTokens,
    sessionPromptTokens: current?.sessionPromptTokens,
    sessionCompletionTokens: current?.sessionCompletionTokens,
    scope: "assembled-request",
    precision: "estimate",
    limit: limitFor(target),
    observedAt: now(),
  });
}

export interface ContextProjection {
  readonly contextSnapshot: ContextSnapshotV1 | undefined;
  readonly contextUsage: ContextUsageSnapshot | undefined;
  readonly contextChip: string | undefined;
}

export function createContextProjector(
  formatChip: (snapshot: ContextUsageSnapshot) => string,
): (
  target: ContextUsageTarget,
  history: readonly ChatMessage[],
  current: ContextSnapshotV1 | undefined,
  now?: ContextClock,
) => ContextProjection {
  let cache: { key: string; value: ContextProjection } | undefined;
  return (target, history, current, now = systemNow) => {
    const first = history[0];
    const last = history[history.length - 1];
    const key = [
      target.provider ?? "",
      target.model ?? "",
      target.contextLimitTokens ?? 0,
      history.length,
      first?.content.length ?? 0,
      last?.content.length ?? 0,
      current?.version ?? 0,
      current?.contextTokens ?? -1,
      current?.scope ?? "",
      current?.precision ?? "",
      current?.limit.source ?? "",
      current?.limit.tokens ?? -1,
      current?.cache.kind ?? "",
      current?.cache.kind === "reported" ? current.cache.readTokens ?? -1 : -1,
      current?.cache.kind === "reported"
        ? current.cache.creationTokens ?? -1
        : -1,
      current?.cache.kind === "reported"
        ? current.cache.uncachedTokens ?? -1
        : -1,
      current?.reasoning.kind ?? "",
      current?.reasoning.kind === "reported"
        ? current.reasoning.outputTokens ?? -1
        : -1,
      current?.reasoning.kind === "reported"
        ? current.reasoning.inputArtifactTokens ?? -1
        : -1,
      current?.observedAt ?? -1,
    ].join("|");
    if (cache?.key === key) return cache.value;
    const contextSnapshot = resolveContextSnapshot(
      target,
      history,
      current,
      now,
    );
    const contextUsage = contextSnapshot
      ? toLegacyContextUsage(contextSnapshot)
      : undefined;
    const value: ContextProjection = {
      contextSnapshot,
      contextUsage,
      contextChip: contextUsage ? formatChip(contextUsage) : undefined,
    };
    cache = { key, value };
    return value;
  };
}

export interface PartialUsageSnapshot {
  readonly contextTokens: number;
  readonly contextLimit?: number | undefined;
  readonly lastCompletionTokens?: number | undefined;
  readonly sessionPromptTokens?: number | undefined;
  readonly sessionCompletionTokens?: number | undefined;
  readonly exact: boolean;
  readonly contextSnapshot?: unknown;
}

export function restoredContextSnapshot(
  target: ContextUsageTarget,
  usage:
    | PartialUsageSnapshot
    | ContextUsageSnapshot
    | ContextSnapshotV1
    | undefined,
  now: ContextClock = systemNow,
): ContextSnapshotV1 | undefined {
  if (!usage) return undefined;
  if (isContextSnapshotV1(usage)) {
    return usage.contextTokens > 0
      ? withContextSnapshotLimit(usage, limitFor(target))
      : undefined;
  }
  const persisted = (usage as PartialUsageSnapshot).contextSnapshot;
  if (isContextSnapshotV1(persisted) && persisted.contextTokens > 0) {
    return withContextSnapshotLimit(persisted, limitFor(target));
  }
  if (usage.contextTokens <= 0) return undefined;
  return contextSnapshotFromLegacy(
    {
      contextTokens: usage.contextTokens,
      contextLimit: usage.contextLimit ?? 0,
      lastCompletionTokens: usage.lastCompletionTokens ?? 0,
      sessionPromptTokens: usage.sessionPromptTokens ?? 0,
      sessionCompletionTokens: usage.sessionCompletionTokens ?? 0,
      exact: usage.exact === true,
    },
    limitFor(target),
    now(),
  );
}

export function resolveContextUsageSnapshot(
  target: ContextUsageTarget,
  history: readonly ChatMessage[],
  current: ContextUsageSnapshot | undefined,
): ContextUsageSnapshot | undefined {
  const canonical = resolveContextSnapshot(
    target,
    history,
    current
      ? contextSnapshotFromLegacy(current, limitFor(target))
      : undefined,
  );
  return canonical ? toLegacyContextUsage(canonical) : undefined;
}

export function compactedUsageSnapshot(
  target: ContextUsageTarget,
  current: ContextUsageSnapshot | undefined,
  history: readonly ChatMessage[],
  afterTokens?: number,
): ContextUsageSnapshot {
  return toLegacyContextUsage(
    compactedContextSnapshot(
      target,
      current ? contextSnapshotFromLegacy(current, limitFor(target)) : undefined,
      history,
      afterTokens,
      "message-history",
    ),
  );
}

export function estimatedUsageSnapshot(
  target: ContextUsageTarget,
  current: ContextUsageSnapshot | undefined,
  estimatedTokens: number,
): ContextUsageSnapshot | undefined {
  const canonical = estimatedContextSnapshot(
    target,
    current ? contextSnapshotFromLegacy(current, limitFor(target)) : undefined,
    estimatedTokens,
  );
  return canonical ? toLegacyContextUsage(canonical) : undefined;
}
