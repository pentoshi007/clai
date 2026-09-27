import { estimateMessagesTokens } from "../../agent/context-manager.js";
import {
  MIN_AUTO_COMPACT_REQUEST_TOKENS,
  autoCompactTriggerTokens,
} from "../../agent/request-budget.js";
import { resolveEffectiveContextLimit } from "../../agent/request-accounting.js";
import {
  resolveContextWindow,
  type ContextWindowSource,
} from "../../llm/context-windows.js";
import { calibratedRequestTokens } from "../../llm/token-estimate-calibration.js";
import {
  contextSnapshotFromLegacy,
  createContextSnapshot,
  isContextSnapshotV1,
  isProviderMeasuredPrecision,
  toLegacyContextUsage,
  withContextSnapshotLimit,
  type ContextAttemptReference,
  type ContextLimitSource,
  type ContextSnapshotCache,
  type ContextSnapshotLimit,
  type ContextSnapshotPrecision,
  type ContextSnapshotReasoning,
  type ContextSnapshotScope,
  type ContextSnapshotV1,
} from "../../llm/context-snapshot.js";
import type { ContextUsageSnapshot } from "../../llm/token-usage.js";
import { effectivePromptTokens } from "../../llm/token-usage.js";
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

const LIMIT_SOURCE_BY_WINDOW: Readonly<Record<ContextWindowSource, ContextLimitSource>> = {
  "session-override": "session-override",
  provider: "model-catalog",
  "model-table": "model-table",
  default: "default",
};

function limitFor(target: ContextUsageTarget): ContextSnapshotLimit {
  const window = resolveContextWindow({
    provider: target.provider,
    model: target.model,
    contextLimitTokens: contextUsageLimit(target) || undefined,
    minOverrideTokens: MIN_AUTO_COMPACT_REQUEST_TOKENS,
  });
  return {
    source: LIMIT_SOURCE_BY_WINDOW[window.source],
    tokens: window.tokens,
    ...(window.providerTokens !== undefined
      ? { providerTokens: window.providerTokens }
      : {}),
    ...(window.overrideTokens !== undefined
      ? { requestedTokens: window.overrideTokens }
      : {}),
    compactTriggerTokens: autoCompactTriggerTokens(target),
  };
}

function sameLimit(
  left: ContextSnapshotLimit,
  right: ContextSnapshotLimit,
): boolean {
  return (
    left.source === right.source &&
    left.tokens === right.tokens &&
    left.providerTokens === right.providerTokens &&
    left.requestedTokens === right.requestedTokens &&
    left.compactTriggerTokens === right.compactTriggerTokens
  );
}

function usagePrecision(usage: TokenUsage): ContextSnapshotPrecision {
  if (usage.exact) return "provider-exact";
  return usage.promptTokensSource === "provider-ratio" ? "provider-ratio" : "estimate";
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

export function resolveContextSnapshot(
  target: ContextUsageTarget,
  current: ContextSnapshotV1 | undefined,
): ContextSnapshotV1 | undefined {
  if (!current) return undefined;
  return sameLimit(current.limit, limitFor(target))
    ? current
    : withContextSnapshotLimit(current, limitFor(target));
}

export function contextSnapshotForRoute(
  target: ContextUsageTarget,
  current: ContextSnapshotV1 | undefined,
): ContextSnapshotV1 | undefined {
  if (!current) return undefined;
  const attempt = current.attempt;
  const measuredOnOtherRoute =
    isProviderMeasuredPrecision(current.precision) &&
    attempt.kind === "generation" &&
    (attempt.provider !== target.provider || attempt.model !== target.model);
  if (!measuredOnOtherRoute) return resolveContextSnapshot(target, current);
  return createContextSnapshot({
    contextTokens: current.contextTokens,
    lastCompletionTokens: current.lastCompletionTokens,
    sessionPromptTokens: current.sessionPromptTokens,
    sessionCompletionTokens: current.sessionCompletionTokens,
    scope: current.scope,
    precision: "estimate",
    limit: limitFor(target),
    cache: current.cache,
    reasoning: current.reasoning,
    attempt,
    observedAt: current.observedAt,
  });
}

function accumulatedSessionTokens(
  current: ContextSnapshotV1 | undefined,
  usage: TokenUsage,
): { sessionPromptTokens: number; sessionCompletionTokens: number } {
  return {
    sessionPromptTokens:
      (current?.sessionPromptTokens ?? 0) +
      (usage.exact && hasPromptMeasurement(usage) ? usage.promptTokens : 0),
    sessionCompletionTokens:
      (current?.sessionCompletionTokens ?? 0) +
      (usage.exact ? usage.completionTokens : 0),
  };
}

export function recordAuxiliaryUsageSnapshot(
  target: ContextUsageTarget,
  current: ContextSnapshotV1 | undefined,
  usage: TokenUsage,
): ContextSnapshotV1 | undefined {
  if (!current) return undefined;
  return createContextSnapshot({
    contextTokens: current.contextTokens,
    lastCompletionTokens: current.lastCompletionTokens,
    ...accumulatedSessionTokens(current, usage),
    scope: current.scope,
    precision: current.precision,
    limit: limitFor(target),
    cache: current.cache,
    reasoning: current.reasoning,
    attempt: current.attempt,
    observedAt: current.observedAt,
  });
}

export function recordContextUsageSnapshot(
  target: ContextUsageTarget,
  current: ContextSnapshotV1 | undefined,
  usage: TokenUsage,
  attempt: ContextAttemptReference | undefined,
  now: ContextClock = systemNow,
): ContextSnapshotV1 {
  const consumedPromptTokens = effectivePromptTokens(usage);
  const { sessionPromptTokens, sessionCompletionTokens } = accumulatedSessionTokens(
    current,
    usage,
  );
  const cache = reportedCache(usage);
  const reasoning = reportedReasoning(usage);
  if (consumedPromptTokens === undefined) {
    return createContextSnapshot({
      contextTokens: current?.contextTokens ?? 0,
      lastCompletionTokens: usage.completionTokens,
      sessionPromptTokens,
      sessionCompletionTokens,
      scope: current?.scope ?? "unknown",
      precision: current?.precision ?? "unknown",
      limit: limitFor(target),
      ...(cache ? { cache } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(attempt ? { attempt } : {}),
      observedAt: now(),
    });
  }
  return createContextSnapshot({
    contextTokens: consumedPromptTokens,
    lastCompletionTokens: usage.completionTokens,
    sessionPromptTokens,
    sessionCompletionTokens,
    scope: "provider-request",
    precision: usagePrecision(usage),
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

export interface ContextProjection {
  readonly contextSnapshot: ContextSnapshotV1 | undefined;
  readonly contextUsage: ContextUsageSnapshot;
  readonly contextChip: string;
  readonly contextLimit: ContextSnapshotLimit;
}

export function createContextProjector(
  formatChip: (snapshot: ContextUsageSnapshot) => string,
): (
  target: ContextUsageTarget,
  current: ContextSnapshotV1 | undefined,
) => ContextProjection {
  return (target, current) => {
    const contextSnapshot = resolveContextSnapshot(target, current);
    const view =
      contextSnapshot ??
      createContextSnapshot({
        contextTokens: 0,
        scope: "unknown",
        precision: "unknown",
        limit: limitFor(target),
      });
    const contextUsage = toLegacyContextUsage(view);
    return {
      contextSnapshot,
      contextUsage,
      contextChip: formatChip(contextUsage),
      contextLimit: view.limit,
    };
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
    return usage.contextTokens > 0 || usage.precision === "provider-exact"
      ? withContextSnapshotLimit(usage, limitFor(target))
      : undefined;
  }
  const persisted = (usage as PartialUsageSnapshot).contextSnapshot;
  if (
    isContextSnapshotV1(persisted) &&
    (persisted.contextTokens > 0 || persisted.precision === "provider-exact")
  ) {
    return withContextSnapshotLimit(persisted, limitFor(target));
  }
  if (usage.contextTokens < 0 || (usage.contextTokens === 0 && !usage.exact)) {
    return undefined;
  }
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
