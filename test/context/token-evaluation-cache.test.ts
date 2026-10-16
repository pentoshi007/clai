import { expect, it } from "vitest";
import { summarizeEvaluationCache, type EvaluationCacheObservation } from "../../scripts/token-evaluation-cache.js";

const warm: EvaluationCacheObservation = { temperature: "warm", eligibility: "eligible", eligiblePrefixTokens: 2000, cachedInputTokens: 1000, cacheWriteTokens: 0 };
it("uses all known warm eligible requests, keeps misses, and separates cold writes and unknowns", () => {
  const result = summarizeEvaluationCache([{ ...warm, temperature: "cold", cacheWriteTokens: 2000 }, warm, { ...warm, cachedInputTokens: 0 },
    { ...warm, cachedInputTokens: null }, { ...warm, eligibility: "unknown" }, { ...warm, eligibility: "ineligible" }]);
  expect(result).toMatchObject({ coldRequests: 1, warmRequests: 5, warmEligibleRequests: 3, warmEligibleKnownUsage: 2, knownCacheHitRate: 0.5,
    eligiblePrefixReuse: null, unknownWarmCacheUsage: 1, unknownEligibilityRequests: 1, knownColdCacheWriteTokens: 2000 });
  expect(summarizeEvaluationCache([warm, { ...warm, cachedInputTokens: 0 }]).eligiblePrefixReuse).toBe(0.25);
});
it("does not turn stable hashes, unknown eligibility, unknown usage or an invalid denominator into cache success", () => {
  expect(summarizeEvaluationCache([]).knownCacheHitRate).toBeNull();
  expect(summarizeEvaluationCache([{ ...warm, eligibility: "unknown" }]).eligiblePrefixReuse).toBeNull();
  expect(summarizeEvaluationCache([{ ...warm, cachedInputTokens: null }]).knownCacheHitRate).toBeNull();
  expect(summarizeEvaluationCache([{ ...warm, eligiblePrefixTokens: null }]).eligiblePrefixReuse).toBeNull();
  expect(summarizeEvaluationCache([{ ...warm, cachedInputTokens: 3000 }]).eligiblePrefixReuse).toBeNull();
  expect(summarizeEvaluationCache([{ ...warm, temperature: "unknown" }]).unknownTemperatureRequests).toBe(1);
});
