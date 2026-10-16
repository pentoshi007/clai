import type { EvaluationRoute } from "./token-evaluation-config.js";
import type { EvaluationAttempt, EvaluationWire } from "./token-evaluation-metrics.js";
import { pairedRejectionReasons, summarizeAttempts, wirePrefixStable } from "./token-evaluation-metrics.js";

export interface EvaluationReport {
  readonly version: 1;
  readonly fixture: string;
  readonly variant: string;
  readonly repeat: number;
  readonly route: EvaluationRoute;
  readonly passed: boolean;
  readonly error: boolean;
  readonly modelRounds: number | null;
  readonly successfulModelRounds: number;
  readonly providerInvocations: number;
  readonly auxiliaryInvocations: number;
  readonly toolCalls: number;
  readonly toolErrors: number;
  readonly blockedCalls: number;
  readonly elapsedMs: number;
  readonly firstTokenMs: number | null;
  readonly peakRssBytes: number;
  readonly cpuMicroseconds: number;
  readonly observerOverheadMs: number;
  readonly attempts: readonly EvaluationAttempt[];
  readonly usageSummary: ReturnType<typeof summarizeAttempts>;
  readonly cost: null;
  readonly firstAttemptValidity: number | null;
  readonly repairCalls: number | null;
  readonly wires: readonly EvaluationWire[];
  readonly cache: { readonly knownCacheHitRate: number | null; readonly eligiblePrefixReuse: number | null; readonly warmEligibleRequests: number | null };
  readonly coverageGaps: readonly string[];
}
export function compareEvaluationReports(before: EvaluationReport, after: EvaluationReport) {
  const gate = (report: EvaluationReport) => ({
    passed: report.passed, error: report.error, modelRounds: report.modelRounds, toolCalls: report.toolCalls,
    toolErrors: report.toolErrors, blockedCalls: report.blockedCalls, prefixStable: wirePrefixStable(report.wires),
    elapsedMs: report.elapsedMs, firstTokenMs: report.firstTokenMs,
    inputTokens: summarizeAttempts(report.attempts).inputTokens, firstInputTokens: summarizeAttempts(report.attempts).firstInputTokens,
    knownCacheHitRate: report.cache.knownCacheHitRate, eligiblePrefixReuse: report.cache.eligiblePrefixReuse,
  });
  const reasons = pairedRejectionReasons(gate(before), gate(after));
  if (JSON.stringify(before.route) !== JSON.stringify(after.route) || before.fixture !== after.fixture || before.repeat !== after.repeat) reasons.push("unmatched-pair");
  if (before.coverageGaps.length || after.coverageGaps.length) reasons.push("incomplete-coverage");
  if (!summarizeAttempts(before.attempts).providerExact || !summarizeAttempts(after.attempts).providerExact) reasons.push("provider-token-precision-unknown");
  if (before.firstAttemptValidity === null || after.firstAttemptValidity === null || before.repairCalls === null || after.repairCalls === null) reasons.push("first-attempt-reliability-unknown");
  else if (after.firstAttemptValidity < before.firstAttemptValidity || after.repairCalls > before.repairCalls) reasons.push("first-attempt-reliability-regression");
  if (after.peakRssBytes > before.peakRssBytes || after.cpuMicroseconds > before.cpuMicroseconds) reasons.push("local-resource-regression");
  return { fixture: before.fixture, route: before.route, repeat: before.repeat, accepted: reasons.length === 0, reasons };
}
