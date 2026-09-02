import {
  providerIds,
  type GenerationAttemptMode,
  type GenerationAttemptOutcome,
  type GenerationAttemptReason,
  type ProviderId,
} from "../types.js";
import type { OperationUsageSnapshot } from "./operation-usage.js";
import type { ContextUsageSnapshot } from "./token-usage.js";

export const CONTEXT_SNAPSHOT_VERSION = 1 as const;

export type ContextSnapshotScope =
  | "provider-request"
  | "assembled-request"
  | "message-history"
  | "unknown";

export type ContextSnapshotPrecision =
  | "provider-exact"
  | "estimate"
  | "unknown";

export type ContextLimitSource =
  | "session-override"
  | "model-catalog"
  | "configured-trigger"
  | "provider-reported"
  | "unknown";

export interface ContextSnapshotLimit {
  readonly source: ContextLimitSource;
  readonly tokens?: number | undefined;
}

export type ContextSnapshotHeadroom =
  | {
      readonly kind: "known";
      readonly remainingTokens: number;
      readonly effectiveTriggerTokens?: number | undefined;
      readonly outputReserveTokens?: number | undefined;
      readonly safetyMarginTokens?: number | undefined;
    }
  | { readonly kind: "unknown" };

export type ContextSnapshotCache =
  | { readonly kind: "unknown" }
  | {
      readonly kind: "reported";
      readonly readTokens?: number | undefined;
      readonly creationTokens?: number | undefined;
      readonly uncachedTokens?: number | undefined;
    };

export type ContextSnapshotReasoning =
  | { readonly kind: "unknown" }
  | {
      readonly kind: "reported";
      readonly outputTokens?: number | undefined;
      readonly inputArtifactTokens?: number | undefined;
    };

export type ContextAttemptReference =
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "generation";
      readonly sequence: number;
      readonly provider: ProviderId;
      readonly model: string;
      readonly mode: GenerationAttemptMode;
      readonly reason: GenerationAttemptReason;
      readonly outcome: GenerationAttemptOutcome;
    };

export interface ContextSnapshotV1 {
  readonly version: typeof CONTEXT_SNAPSHOT_VERSION;
  readonly contextTokens: number;
  readonly lastCompletionTokens: number;
  readonly sessionPromptTokens: number;
  readonly sessionCompletionTokens: number;
  readonly scope: ContextSnapshotScope;
  readonly precision: ContextSnapshotPrecision;
  readonly limit: ContextSnapshotLimit;
  readonly headroom: ContextSnapshotHeadroom;
  readonly cache: ContextSnapshotCache;
  readonly reasoning: ContextSnapshotReasoning;
  readonly attempt: ContextAttemptReference;
  readonly observedAt: number;
}

export interface CreateContextSnapshotInput {
  readonly contextTokens: number;
  readonly lastCompletionTokens?: number | undefined;
  readonly sessionPromptTokens?: number | undefined;
  readonly sessionCompletionTokens?: number | undefined;
  readonly scope: ContextSnapshotScope;
  readonly precision: ContextSnapshotPrecision;
  readonly limit?: ContextSnapshotLimit | undefined;
  readonly headroom?: ContextSnapshotHeadroom | undefined;
  readonly cache?: ContextSnapshotCache | undefined;
  readonly reasoning?: ContextSnapshotReasoning | undefined;
  readonly attempt?: ContextAttemptReference | undefined;
  readonly observedAt?: number | undefined;
}

const LIMIT_SOURCES = new Set<ContextLimitSource>([
  "session-override",
  "model-catalog",
  "configured-trigger",
  "provider-reported",
  "unknown",
]);

const SCOPES = new Set<ContextSnapshotScope>([
  "provider-request",
  "assembled-request",
  "message-history",
  "unknown",
]);

const PRECISIONS = new Set<ContextSnapshotPrecision>([
  "provider-exact",
  "estimate",
  "unknown",
]);

const UNKNOWN_HEADROOM: ContextSnapshotHeadroom = Object.freeze({
  kind: "unknown" as const,
});
const UNKNOWN_CACHE: ContextSnapshotCache = Object.freeze({
  kind: "unknown" as const,
});
const UNKNOWN_REASONING: ContextSnapshotReasoning = Object.freeze({
  kind: "unknown" as const,
});
const UNAVAILABLE_ATTEMPT: ContextAttemptReference = Object.freeze({
  kind: "unavailable" as const,
});

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function positiveInteger(value: unknown): number | undefined {
  const normalized = optionalNonNegativeInteger(value);
  return normalized !== undefined && normalized > 0 ? normalized : undefined;
}

function normalizeLimit(
  limit: ContextSnapshotLimit | undefined,
): ContextSnapshotLimit {
  if (!limit || !LIMIT_SOURCES.has(limit.source)) {
    return Object.freeze({ source: "unknown" as const });
  }
  const tokens = positiveInteger(limit.tokens);
  return Object.freeze({
    source: limit.source,
    ...(tokens !== undefined ? { tokens } : {}),
  });
}

function normalizeCache(
  cache: ContextSnapshotCache | undefined,
): ContextSnapshotCache {
  if (!cache || cache.kind !== "reported") return UNKNOWN_CACHE;
  const readTokens = optionalNonNegativeInteger(cache.readTokens);
  const creationTokens = optionalNonNegativeInteger(cache.creationTokens);
  const uncachedTokens = optionalNonNegativeInteger(cache.uncachedTokens);
  if (
    readTokens === undefined &&
    creationTokens === undefined &&
    uncachedTokens === undefined
  ) {
    return UNKNOWN_CACHE;
  }
  return Object.freeze({
    kind: "reported" as const,
    ...(readTokens !== undefined ? { readTokens } : {}),
    ...(creationTokens !== undefined ? { creationTokens } : {}),
    ...(uncachedTokens !== undefined ? { uncachedTokens } : {}),
  });
}

function normalizeReasoning(
  reasoning: ContextSnapshotReasoning | undefined,
): ContextSnapshotReasoning {
  if (!reasoning || reasoning.kind !== "reported") return UNKNOWN_REASONING;
  const outputTokens = optionalNonNegativeInteger(reasoning.outputTokens);
  const inputArtifactTokens = optionalNonNegativeInteger(
    reasoning.inputArtifactTokens,
  );
  if (outputTokens === undefined && inputArtifactTokens === undefined) {
    return UNKNOWN_REASONING;
  }
  return Object.freeze({
    kind: "reported" as const,
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(inputArtifactTokens !== undefined ? { inputArtifactTokens } : {}),
  });
}

function derivedHeadroom(
  contextTokens: number,
  scope: ContextSnapshotScope,
  limit: ContextSnapshotLimit,
): ContextSnapshotHeadroom {
  if (
    scope === "message-history" ||
    scope === "unknown" ||
    limit.source !== "session-override" ||
    limit.tokens === undefined
  ) {
    return UNKNOWN_HEADROOM;
  }
  return Object.freeze({
    kind: "known" as const,
    remainingTokens: Math.max(0, limit.tokens - contextTokens),
  });
}

function normalizeObservedAt(value: number | undefined): number {
  const candidate = value ?? Date.now();
  return nonNegativeInteger(candidate);
}

export function createContextSnapshot(
  input: CreateContextSnapshotInput,
): ContextSnapshotV1 {
  const contextTokens = nonNegativeInteger(input.contextTokens);
  const limit = normalizeLimit(input.limit);
  return Object.freeze({
    version: CONTEXT_SNAPSHOT_VERSION,
    contextTokens,
    lastCompletionTokens: nonNegativeInteger(input.lastCompletionTokens),
    sessionPromptTokens: nonNegativeInteger(input.sessionPromptTokens),
    sessionCompletionTokens: nonNegativeInteger(input.sessionCompletionTokens),
    scope: input.scope,
    precision: input.precision,
    limit,
    headroom: input.headroom ?? derivedHeadroom(contextTokens, input.scope, limit),
    cache: normalizeCache(input.cache),
    reasoning: normalizeReasoning(input.reasoning),
    attempt: input.attempt ?? UNAVAILABLE_ATTEMPT,
    observedAt: normalizeObservedAt(input.observedAt),
  });
}

export function toLegacyContextUsage(
  snapshot: ContextSnapshotV1,
): ContextUsageSnapshot {
  return Object.freeze({
    contextTokens: snapshot.contextTokens,
    contextLimit:
      snapshot.limit.source === "session-override" && snapshot.limit.tokens
        ? snapshot.limit.tokens
        : 0,
    lastCompletionTokens: snapshot.lastCompletionTokens,
    sessionPromptTokens: snapshot.sessionPromptTokens,
    sessionCompletionTokens: snapshot.sessionCompletionTokens,
    exact: snapshot.precision === "provider-exact",
  });
}

export function contextLimitFromSessionOverride(
  tokens: number | undefined,
): ContextSnapshotLimit {
  const normalized = positiveInteger(tokens);
  return Object.freeze(
    normalized === undefined
      ? { source: "unknown" as const }
      : { source: "session-override" as const, tokens: normalized },
  );
}

export function withContextSnapshotLimit(
  snapshot: ContextSnapshotV1,
  limit: ContextSnapshotLimit,
): ContextSnapshotV1 {
  const normalizedLimit = normalizeLimit(limit);
  return Object.freeze({
    ...snapshot,
    limit: normalizedLimit,
    headroom: derivedHeadroom(
      snapshot.contextTokens,
      snapshot.scope,
      normalizedLimit,
    ),
  });
}

export function contextSnapshotFromLegacy(
  snapshot: ContextUsageSnapshot,
  limit: ContextSnapshotLimit,
  observedAt?: number | undefined,
): ContextSnapshotV1 {
  return createContextSnapshot({
    contextTokens: snapshot.contextTokens,
    lastCompletionTokens: snapshot.lastCompletionTokens,
    sessionPromptTokens: snapshot.sessionPromptTokens,
    sessionCompletionTokens: snapshot.sessionCompletionTokens,
    scope: snapshot.exact ? "provider-request" : "unknown",
    precision: snapshot.exact ? "provider-exact" : "estimate",
    limit,
    observedAt,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeIntegerValue(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function hasOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeIntegerValue(value);
}

function isContextLimit(value: unknown): value is ContextSnapshotLimit {
  return (
    isRecord(value) &&
    LIMIT_SOURCES.has(value.source as ContextLimitSource) &&
    (value.tokens === undefined ||
      (isNonNegativeIntegerValue(value.tokens) && value.tokens > 0))
  );
}

function isContextHeadroom(value: unknown): value is ContextSnapshotHeadroom {
  if (!isRecord(value)) return false;
  if (value.kind === "unknown") return true;
  return (
    value.kind === "known" &&
    isNonNegativeIntegerValue(value.remainingTokens) &&
    hasOptionalNonNegativeInteger(value.effectiveTriggerTokens) &&
    hasOptionalNonNegativeInteger(value.outputReserveTokens) &&
    hasOptionalNonNegativeInteger(value.safetyMarginTokens)
  );
}

function isContextCache(value: unknown): value is ContextSnapshotCache {
  if (!isRecord(value)) return false;
  if (value.kind === "unknown") return true;
  return (
    value.kind === "reported" &&
    hasOptionalNonNegativeInteger(value.readTokens) &&
    hasOptionalNonNegativeInteger(value.creationTokens) &&
    hasOptionalNonNegativeInteger(value.uncachedTokens)
  );
}

function isContextReasoning(value: unknown): value is ContextSnapshotReasoning {
  if (!isRecord(value)) return false;
  if (value.kind === "unknown") return true;
  return (
    value.kind === "reported" &&
    hasOptionalNonNegativeInteger(value.outputTokens) &&
    hasOptionalNonNegativeInteger(value.inputArtifactTokens)
  );
}

const ATTEMPT_MODES = new Set<GenerationAttemptMode>(["complete", "stream"]);
const ATTEMPT_REASONS = new Set<GenerationAttemptReason>([
  "initial",
  "retry",
  "fallback",
  "adaptation",
  "provider-retry",
]);
const ATTEMPT_OUTCOMES = new Set<GenerationAttemptOutcome>([
  "success",
  "failure",
  "cancelled",
]);
const ATTEMPT_PROVIDERS = new Set<ProviderId>(providerIds);

function isContextAttempt(value: unknown): value is ContextAttemptReference {
  if (!isRecord(value)) return false;
  if (value.kind === "unavailable") return true;
  return (
    value.kind === "generation" &&
    isNonNegativeIntegerValue(value.sequence) &&
    value.sequence > 0 &&
    ATTEMPT_PROVIDERS.has(value.provider as ProviderId) &&
    typeof value.model === "string" &&
    value.model.trim().length > 0 &&
    ATTEMPT_MODES.has(value.mode as GenerationAttemptMode) &&
    ATTEMPT_REASONS.has(value.reason as GenerationAttemptReason) &&
    ATTEMPT_OUTCOMES.has(value.outcome as GenerationAttemptOutcome)
  );
}

export function isContextSnapshotV1(value: unknown): value is ContextSnapshotV1 {
  if (!isRecord(value) || value.version !== CONTEXT_SNAPSHOT_VERSION) return false;
  return (
    SCOPES.has(value.scope as ContextSnapshotScope) &&
    PRECISIONS.has(value.precision as ContextSnapshotPrecision) &&
    isContextLimit(value.limit) &&
    isContextHeadroom(value.headroom) &&
    isContextCache(value.cache) &&
    isContextReasoning(value.reasoning) &&
    isContextAttempt(value.attempt) &&
    [
      value.contextTokens,
      value.lastCompletionTokens,
      value.sessionPromptTokens,
      value.sessionCompletionTokens,
      value.observedAt,
    ].every(isNonNegativeIntegerValue)
  );
}

export function contextAttemptFromOperationUsage(
  operationUsage: OperationUsageSnapshot | undefined,
): ContextAttemptReference {
  const attempt = operationUsage?.attempts.at(-1);
  if (!attempt) return UNAVAILABLE_ATTEMPT;
  return Object.freeze({
    kind: "generation" as const,
    sequence: attempt.sequence,
    provider: attempt.provider,
    model: attempt.model,
    mode: attempt.mode,
    reason: attempt.reason,
    outcome: attempt.outcome,
  });
}
