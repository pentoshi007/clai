export interface EvaluationCacheObservation {
  readonly temperature: "cold" | "warm" | "unknown";
  readonly eligibility: "eligible" | "ineligible" | "unknown";
  readonly eligiblePrefixTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly cacheWriteTokens: number | null;
}

export function summarizeEvaluationCache(observations: readonly EvaluationCacheObservation[]) {
  const warm = observations.filter((entry) => entry.temperature === "warm");
  const eligible = warm.filter((entry) => entry.eligibility === "eligible");
  const known = eligible.filter((entry) => entry.cachedInputTokens !== null);
  const bounded = known.filter((entry) => entry.eligiblePrefixTokens !== null && entry.eligiblePrefixTokens > 0 && entry.cachedInputTokens! <= entry.eligiblePrefixTokens);
  const totalEligiblePrefix = bounded.reduce((sum, entry) => sum + entry.eligiblePrefixTokens!, 0);
  return {
    coldRequests: observations.filter((entry) => entry.temperature === "cold").length,
    warmRequests: warm.length,
    unknownTemperatureRequests: observations.filter((entry) => entry.temperature === "unknown").length,
    unknownEligibilityRequests: warm.filter((entry) => entry.eligibility === "unknown").length,
    warmEligibleRequests: eligible.length,
    warmEligibleKnownUsage: known.length,
    unknownWarmCacheUsage: eligible.length - known.length,
    unknownEligiblePrefixDenominators: eligible.length - bounded.length,
    knownCacheHitRate: known.length ? known.filter((entry) => entry.cachedInputTokens! > 0).length / known.length : null,
    eligiblePrefixReuse: totalEligiblePrefix > 0 && bounded.length === eligible.length
      ? bounded.reduce((sum, entry) => sum + entry.cachedInputTokens!, 0) / totalEligiblePrefix : null,
    knownColdCacheWriteTokens: observations.filter((entry) => entry.temperature === "cold").reduce((sum, entry) => sum + (entry.cacheWriteTokens ?? 0), 0),
    unknownColdCacheWrites: observations.filter((entry) => entry.temperature === "cold" && entry.cacheWriteTokens === null).length,
  };
}
