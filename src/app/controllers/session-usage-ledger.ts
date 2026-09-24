import {
  providerIds,
  type ProviderId,
  type TokenUsage,
  type UsageCharge,
} from "../../types.js";

export interface SessionUsageRoute {
  readonly provider: ProviderId | undefined;
  readonly model: string | undefined;
  readonly api?: string | undefined;
  readonly apis: readonly string[];
  readonly requests: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly completionTokensKnown?: false | undefined;
  readonly totalTokens: number;
  readonly cachedPromptTokens: number | undefined;
  readonly cacheCreationTokens: number | undefined;
  readonly uncachedPromptTokens: number | undefined;
  readonly reasoningTokens: number | undefined;
  readonly reasoningObserved: boolean;
  readonly cacheBasePromptTokens: number | undefined;
  readonly estimatedRequests: number;
  readonly unmeasuredPromptRequests: number;
  readonly charges: readonly UsageCharge[];
}

export interface SessionUsageTotals {
  readonly routes: number;
  readonly requests: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly completionTokensKnown?: false | undefined;
  readonly totalTokens: number;
  readonly cachedPromptTokens: number | undefined;
  readonly cacheCreationTokens: number | undefined;
  readonly uncachedPromptTokens: number | undefined;
  readonly reasoningTokens: number | undefined;
  readonly reasoningObserved: boolean;
  readonly cacheBasePromptTokens: number | undefined;
  readonly estimatedRequests: number;
  readonly unmeasuredPromptRequests: number;
  readonly apis: readonly string[];
  readonly charges: readonly UsageCharge[];
}

export interface SessionUsageReport {
  readonly routes: readonly SessionUsageRoute[];
  readonly totals: SessionUsageTotals;
}

export interface PersistedRouteUsage {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly api?: string | undefined;
  readonly apis?: readonly string[] | undefined;
  readonly requests: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly completionTokensKnown?: false | undefined;
  readonly totalTokens: number;
  readonly cachedPromptTokens?: number | undefined;
  readonly cacheCreationTokens?: number | undefined;
  readonly uncachedPromptTokens?: number | undefined;
  readonly reasoningTokens?: number | undefined;
  readonly reasoningObserved?: boolean | undefined;
  readonly cacheBasePromptTokens?: number | undefined;
  readonly estimatedRequests?: number | undefined;
  readonly unmeasuredPromptRequests?: number | undefined;
  readonly charges?: readonly UsageCharge[] | undefined;
}

interface MutableRoute {
  provider: ProviderId | undefined;
  model: string | undefined;
  apis: Set<string>;
  sequence: number;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  completionKnown: boolean;
  totalTokens: number;
  cachedPromptTokens: number | undefined;
  cacheCreationTokens: number | undefined;
  uncachedPromptTokens: number | undefined;
  reasoningTokens: number | undefined;
  reasoningObserved: boolean;
  cacheBasePromptTokens: number | undefined;
  estimatedRequests: number;
  unmeasuredPromptRequests: number;
  charges: Map<string, UsageCharge>;
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

function normalizeApi(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // keep known wire identifiers lower-cased, but preserve case for custom
  return trimmed.toLowerCase();
}

function toRoute(entry: MutableRoute): SessionUsageRoute {
  const apis = [...entry.apis].sort();
  return Object.freeze({
    provider: entry.provider,
    model: entry.model,
    ...(apis.length === 1 ? { api: apis[0] } : {}),
    apis,
    requests: entry.requests,
    promptTokens: entry.promptTokens,
    completionTokens: entry.completionTokens,
    ...(entry.completionKnown ? {} : { completionTokensKnown: false as const }),
    totalTokens: entry.totalTokens,
    cachedPromptTokens: entry.cachedPromptTokens,
    cacheCreationTokens: entry.cacheCreationTokens,
    uncachedPromptTokens: entry.uncachedPromptTokens,
    reasoningTokens: entry.reasoningTokens,
    reasoningObserved: entry.reasoningObserved,
    cacheBasePromptTokens: entry.cacheBasePromptTokens,
    estimatedRequests: entry.estimatedRequests,
    unmeasuredPromptRequests: entry.unmeasuredPromptRequests,
    charges: Object.freeze([...entry.charges.values()]),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedCharge(value: unknown): UsageCharge | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.amount !== "number" ||
    !Number.isFinite(value.amount) ||
    value.amount < 0 ||
    typeof value.unit !== "string" ||
    !value.unit.trim()
  ) {
    return undefined;
  }
  const currency = typeof value.currency === "string" ? value.currency.trim() : "";
  const label = typeof value.label === "string" ? value.label.trim() : "";
  return {
    amount: value.amount,
    unit: value.unit.trim(),
    ...(currency ? { currency } : {}),
    ...(label ? { label } : {}),
  };
}

function chargeKey(charge: UsageCharge): string {
  return [charge.unit, charge.currency ?? "", charge.label ?? ""]
    .map((part) => part.toLowerCase())
    .join("\u0000");
}

function mergeCharges(
  current: readonly UsageCharge[],
  incoming: readonly UsageCharge[],
): UsageCharge[] {
  const merged = new Map(current.map((charge) => [chargeKey(charge), charge]));
  for (const charge of incoming) {
    const key = chargeKey(charge);
    const prior = merged.get(key);
    merged.set(key, {
      ...charge,
      amount: (prior?.amount ?? 0) + charge.amount,
    });
  }
  return [...merged.values()].sort(
    (left, right) => chargeKey(left).localeCompare(chargeKey(right)),
  );
}

function recordCharges(
  target: Map<string, UsageCharge>,
  rawCharges: readonly unknown[] | undefined,
): void {
  for (const raw of rawCharges ?? []) {
    const charge = normalizedCharge(raw);
    if (!charge) continue;
    const key = chargeKey(charge);
    const prior = target.get(key);
    target.set(key, {
      ...charge,
      amount: (prior?.amount ?? 0) + charge.amount,
    });
  }
}

function restoredCharges(value: unknown): Map<string, UsageCharge> {
  const charges = new Map<string, UsageCharge>();
  if (Array.isArray(value)) recordCharges(charges, value);
  return charges;
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
    api?: string | undefined,
  ): void {
    const normalizedModel = normalizeModel(model);
    const key = routeKey(provider, normalizedModel);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        provider,
        model: normalizedModel,
        apis: new Set<string>(),
        sequence: this.sequence++,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        completionKnown: true,
        totalTokens: 0,
        cachedPromptTokens: undefined,
        cacheCreationTokens: undefined,
        uncachedPromptTokens: undefined,
        reasoningTokens: undefined,
        reasoningObserved: false,
        cacheBasePromptTokens: undefined,
        estimatedRequests: 0,
        unmeasuredPromptRequests: 0,
        charges: new Map(),
      };
      this.entries.set(key, entry);
    }
    const normalizedApi = normalizeApi(api);
    if (normalizedApi) entry.apis.add(normalizedApi);

    const promptMeasured = usage.promptTokensKnown !== false;
    const completionMeasured = usage.exact !== false;
    const promptTokens = promptMeasured ? nonNegativeInteger(usage.promptTokens) : 0;
    const completionTokens = completionMeasured ? nonNegativeInteger(usage.completionTokens) : 0;
    const cached = optionalNonNegativeInteger(usage.cachedPromptTokens);
    const rawCached = cached !== undefined && promptMeasured ? Math.min(cached, promptTokens) : cached;

    entry.requests += 1;
    entry.promptTokens += promptTokens;
    entry.completionTokens += completionTokens;
    entry.completionKnown &&= completionMeasured;
    entry.totalTokens += nonNegativeInteger(usage.totalTokens);
    entry.cachedPromptTokens = addOptional(entry.cachedPromptTokens, rawCached);
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
    if (rawCached !== undefined && promptMeasured) {
      entry.cacheBasePromptTokens =
        (entry.cacheBasePromptTokens ?? 0) + promptTokens;
    }
    if (!usage.exact) entry.estimatedRequests += 1;
    if (!promptMeasured) entry.unmeasuredPromptRequests += 1;
    recordCharges(entry.charges, usage.charges);
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
    let completionKnown = routes.length > 0;
    let totalTokens = 0;
    let cachedPromptTokens: number | undefined;
    let cacheCreationTokens: number | undefined;
    let uncachedPromptTokens: number | undefined;
    let reasoningTokens: number | undefined;
    let reasoningObserved = false;
    let cacheBasePromptTokens: number | undefined;
    let estimatedRequests = 0;
    let unmeasuredPromptRequests = 0;
    let charges: UsageCharge[] = [];
    const totalsApis = new Set<string>();
    for (const route of routes) {
      requests += route.requests;
      promptTokens += route.promptTokens;
      completionTokens += route.completionTokens;
      completionKnown &&= route.completionTokensKnown !== false;
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
      charges = mergeCharges(charges, route.charges);
      for (const api of route.apis) totalsApis.add(api);
    }

    return Object.freeze({
      routes,
      totals: Object.freeze({
        routes: routes.length,
        requests,
        promptTokens,
        completionTokens,
        ...(completionKnown ? {} : { completionTokensKnown: false as const }),
        totalTokens,
        cachedPromptTokens,
        cacheCreationTokens,
        uncachedPromptTokens,
        reasoningTokens,
        reasoningObserved,
        cacheBasePromptTokens,
        estimatedRequests,
        unmeasuredPromptRequests,
        apis: Object.freeze([...totalsApis].sort()),
        charges: Object.freeze(charges),
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
        ...(entry.apis.size > 0 ? { apis: [...entry.apis].sort() } : {}),
        ...(entry.apis.size === 1 ? { api: [...entry.apis][0] } : {}),
        requests: entry.requests,
        promptTokens: entry.promptTokens,
        completionTokens: entry.completionTokens,
        ...(entry.completionKnown ? {} : { completionTokensKnown: false as const }),
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
        ...(entry.charges.size > 0
          ? { charges: [...entry.charges.values()] }
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
      const apis = new Set<string>();
      const rawApis = Array.isArray((raw as Record<string, unknown>).apis)
        ? ((raw as Record<string, unknown>).apis as unknown[])
        : undefined;
      if (rawApis) {
        for (const entry of rawApis) {
          const normalized = normalizeApi(entry);
          if (normalized) apis.add(normalized);
        }
      } else {
        const single = normalizeApi((raw as Record<string, unknown>).api);
        if (single) apis.add(single);
      }
      this.entries.set(key, {
        provider,
        model,
        apis,
        sequence: this.sequence++,
        requests,
        promptTokens,
        completionTokens,
        completionKnown: (raw as Record<string, unknown>).completionTokensKnown !== false,
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
        charges: restoredCharges(raw.charges),
      });
    }
  }
}
