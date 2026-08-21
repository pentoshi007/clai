import { providerIds, type ProviderId, type TokenUsage } from "../../types.js";

export interface SessionUsageRoute {
  readonly provider: ProviderId | undefined;
  readonly model: string | undefined;
  readonly requests: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly cachedPromptTokens: number | undefined;
  readonly cacheCreationTokens: number | undefined;
  readonly uncachedPromptTokens: number | undefined;
  readonly reasoningTokens: number | undefined;
  readonly reasoningObserved: boolean;
  readonly cacheBasePromptTokens: number | undefined;
  readonly estimatedRequests: number;
  readonly unmeasuredPromptRequests: number;
}

export interface SessionUsageTotals {
  readonly routes: number;
  readonly requests: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly cachedPromptTokens: number | undefined;
  readonly cacheCreationTokens: number | undefined;
  readonly uncachedPromptTokens: number | undefined;
  readonly reasoningTokens: number | undefined;
  readonly reasoningObserved: boolean;
  readonly cacheBasePromptTokens: number | undefined;
  readonly estimatedRequests: number;
  readonly unmeasuredPromptRequests: number;
}

export interface SessionUsageReport {
  readonly routes: readonly SessionUsageRoute[];
  readonly totals: SessionUsageTotals;
}

export interface PersistedRouteUsage {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly requests: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly cachedPromptTokens?: number | undefined;
  readonly cacheCreationTokens?: number | undefined;
  readonly uncachedPromptTokens?: number | undefined;
  readonly reasoningTokens?: number | undefined;
  readonly reasoningObserved?: boolean | undefined;
  readonly cacheBasePromptTokens?: number | undefined;
  readonly estimatedRequests?: number | undefined;
  readonly unmeasuredPromptRequests?: number | undefined;
}

interface MutableRoute {
  provider: ProviderId | undefined;
  model: string | undefined;
  sequence: number;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens: number | undefined;
  cacheCreationTokens: number | undefined;
  uncachedPromptTokens: number | undefined;
  reasoningTokens: number | undefined;
  reasoningObserved: boolean;
  cacheBasePromptTokens: number | undefined;
  estimatedRequests: number;
  unmeasuredPromptRequests: number;
}

const KNOWN_PROVIDERS: ReadonlySet<string> = new Set(providerIds);
const MAX_PERSISTED_ROUTES = 64;

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function addOptional(
  current: number | undefined,
  increment: number | undefined,
): number | undefined {
  if (increment === undefined) return current;
  return (current ?? 0) + increment;
}

function routeKey(
  provider: ProviderId | undefined,
  model: string | undefined,
): string {
  return `${provider ?? ""}\u0000${model ?? ""}`;
}

function normalizeModel(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeProvider(provider: unknown): ProviderId | undefined {
  return typeof provider === "string" && KNOWN_PROVIDERS.has(provider)
    ? (provider as ProviderId)
    : undefined;
}

function toRoute(entry: MutableRoute): SessionUsageRoute {
  return Object.freeze({
    provider: entry.provider,
    model: entry.model,
    requests: entry.requests,
    promptTokens: entry.promptTokens,
    completionTokens: entry.completionTokens,
    totalTokens: entry.totalTokens,
    cachedPromptTokens: entry.cachedPromptTokens,
    cacheCreationTokens: entry.cacheCreationTokens,
    uncachedPromptTokens: entry.uncachedPromptTokens,
    reasoningTokens: entry.reasoningTokens,
    reasoningObserved: entry.reasoningObserved,
    cacheBasePromptTokens: entry.cacheBasePromptTokens,
    estimatedRequests: entry.estimatedRequests,
    unmeasuredPromptRequests: entry.unmeasuredPromptRequests,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function usageCacheHitRate(input: {
  readonly cachedPromptTokens: number | undefined;
  readonly cacheBasePromptTokens: number | undefined;
}): number | undefined {
  const cached = input.cachedPromptTokens;
  const base = input.cacheBasePromptTokens;
  if (cached === undefined || base === undefined || base <= 0) return undefined;
  return Math.min(1, cached / base);
}

export class SessionUsageLedger {
  private readonly entries = new Map<string, MutableRoute>();
  private sequence = 0;

  record(
    usage: TokenUsage,
    provider: ProviderId | undefined,
    model: string | undefined,
  ): void {
    const normalizedModel = normalizeModel(model);
    const key = routeKey(provider, normalizedModel);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        provider,
        model: normalizedModel,
        sequence: this.sequence++,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedPromptTokens: undefined,
        cacheCreationTokens: undefined,
        uncachedPromptTokens: undefined,
        reasoningTokens: undefined,
        reasoningObserved: false,
        cacheBasePromptTokens: undefined,
        estimatedRequests: 0,
        unmeasuredPromptRequests: 0,
      };
      this.entries.set(key, entry);
    }

    const promptMeasured = usage.promptTokensKnown !== false;
    const promptTokens = promptMeasured ? nonNegativeInteger(usage.promptTokens) : 0;
    const completionTokens = nonNegativeInteger(usage.completionTokens);
    const cached = optionalNonNegativeInteger(usage.cachedPromptTokens);

    entry.requests += 1;
    entry.promptTokens += promptTokens;
    entry.completionTokens += completionTokens;
    entry.totalTokens += nonNegativeInteger(usage.totalTokens);
    entry.cachedPromptTokens = addOptional(entry.cachedPromptTokens, cached);
    entry.cacheCreationTokens = addOptional(
      entry.cacheCreationTokens,
      optionalNonNegativeInteger(usage.cacheCreationTokens),
    );
    entry.uncachedPromptTokens = addOptional(
      entry.uncachedPromptTokens,
      optionalNonNegativeInteger(usage.uncachedPromptTokens),
    );
    entry.reasoningTokens = addOptional(
      entry.reasoningTokens,
      optionalNonNegativeInteger(usage.reasoningTokens),
    );
    entry.reasoningObserved ||= usage.reasoningObserved === true;
    if (cached !== undefined && promptMeasured) {
      entry.cacheBasePromptTokens =
        (entry.cacheBasePromptTokens ?? 0) + promptTokens;
    }
    if (!usage.exact) entry.estimatedRequests += 1;
    if (!promptMeasured) entry.unmeasuredPromptRequests += 1;
  }

  isEmpty(): boolean {
    return this.entries.size === 0;
  }

  clear(): void {
    this.entries.clear();
    this.sequence = 0;
  }

  report(): SessionUsageReport {
    const routes = [...this.entries.values()]
      .sort(
        (left, right) =>
          right.totalTokens - left.totalTokens || left.sequence - right.sequence,
      )
      .map(toRoute);

    let requests = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let cachedPromptTokens: number | undefined;
    let cacheCreationTokens: number | undefined;
    let uncachedPromptTokens: number | undefined;
    let reasoningTokens: number | undefined;
    let reasoningObserved = false;
    let cacheBasePromptTokens: number | undefined;
    let estimatedRequests = 0;
    let unmeasuredPromptRequests = 0;
    for (const route of routes) {
      requests += route.requests;
      promptTokens += route.promptTokens;
      completionTokens += route.completionTokens;
      totalTokens += route.totalTokens;
      cachedPromptTokens = addOptional(cachedPromptTokens, route.cachedPromptTokens);
      cacheCreationTokens = addOptional(
        cacheCreationTokens,
        route.cacheCreationTokens,
      );
      uncachedPromptTokens = addOptional(
        uncachedPromptTokens,
        route.uncachedPromptTokens,
      );
      reasoningTokens = addOptional(reasoningTokens, route.reasoningTokens);
      reasoningObserved ||= route.reasoningObserved;
      cacheBasePromptTokens = addOptional(
        cacheBasePromptTokens,
        route.cacheBasePromptTokens,
      );
      estimatedRequests += route.estimatedRequests;
      unmeasuredPromptRequests += route.unmeasuredPromptRequests;
    }

    return Object.freeze({
      routes,
      totals: Object.freeze({
        routes: routes.length,
        requests,
        promptTokens,
        completionTokens,
        totalTokens,
        cachedPromptTokens,
        cacheCreationTokens,
        uncachedPromptTokens,
        reasoningTokens,
        reasoningObserved,
        cacheBasePromptTokens,
        estimatedRequests,
        unmeasuredPromptRequests,
      }),
    });
  }

  persist(): readonly PersistedRouteUsage[] | undefined {
    if (this.entries.size === 0) return undefined;
    const rows = [...this.entries.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, MAX_PERSISTED_ROUTES)
      .map((entry) => ({
        ...(entry.provider !== undefined ? { provider: entry.provider } : {}),
        ...(entry.model !== undefined ? { model: entry.model } : {}),
        requests: entry.requests,
        promptTokens: entry.promptTokens,
        completionTokens: entry.completionTokens,
        totalTokens: entry.totalTokens,
        ...(entry.cachedPromptTokens !== undefined
          ? { cachedPromptTokens: entry.cachedPromptTokens }
          : {}),
        ...(entry.cacheCreationTokens !== undefined
          ? { cacheCreationTokens: entry.cacheCreationTokens }
          : {}),
        ...(entry.uncachedPromptTokens !== undefined
          ? { uncachedPromptTokens: entry.uncachedPromptTokens }
          : {}),
        ...(entry.reasoningTokens !== undefined
          ? { reasoningTokens: entry.reasoningTokens }
          : {}),
        ...(entry.reasoningObserved ? { reasoningObserved: true } : {}),
        ...(entry.cacheBasePromptTokens !== undefined
          ? { cacheBasePromptTokens: entry.cacheBasePromptTokens }
          : {}),
        ...(entry.estimatedRequests > 0
          ? { estimatedRequests: entry.estimatedRequests }
          : {}),
        ...(entry.unmeasuredPromptRequests > 0
          ? { unmeasuredPromptRequests: entry.unmeasuredPromptRequests }
          : {}),
      }));
    return rows.length > 0 ? rows : undefined;
  }

  restore(rows: unknown): void {
    this.clear();
    if (!Array.isArray(rows)) return;
    for (const raw of rows.slice(0, MAX_PERSISTED_ROUTES)) {
      if (!isRecord(raw)) continue;
      const requests = nonNegativeInteger(raw.requests);
      const promptTokens = nonNegativeInteger(raw.promptTokens);
      const completionTokens = nonNegativeInteger(raw.completionTokens);
      const totalTokens = nonNegativeInteger(raw.totalTokens);
      if (requests === 0 && promptTokens === 0 && completionTokens === 0) continue;
      const provider = normalizeProvider(raw.provider);
      const model = normalizeModel(
        typeof raw.model === "string" ? raw.model : undefined,
      );
      const key = routeKey(provider, model);
      if (this.entries.has(key)) continue;
      this.entries.set(key, {
        provider,
        model,
        sequence: this.sequence++,
        requests,
        promptTokens,
        completionTokens,
        totalTokens: totalTokens || promptTokens + completionTokens,
        cachedPromptTokens: optionalNonNegativeInteger(raw.cachedPromptTokens),
        cacheCreationTokens: optionalNonNegativeInteger(raw.cacheCreationTokens),
        uncachedPromptTokens: optionalNonNegativeInteger(raw.uncachedPromptTokens),
        reasoningTokens: optionalNonNegativeInteger(raw.reasoningTokens),
        reasoningObserved: raw.reasoningObserved === true,
        cacheBasePromptTokens: optionalNonNegativeInteger(
          raw.cacheBasePromptTokens,
        ),
        estimatedRequests: nonNegativeInteger(raw.estimatedRequests),
        unmeasuredPromptRequests: nonNegativeInteger(raw.unmeasuredPromptRequests),
      });
    }
  }
}
