import type { EvaluationRoute } from "./token-evaluation-config.js";
import type { EvaluationAttempt, EvaluationWire } from "./token-evaluation-metrics.js";
import { pairedRejectionReasons, summarizeAttempts, wirePrefixStable, wireHistoryStable } from "./token-evaluation-metrics.js";

export interface EvaluationReport {
  readonly snapshot?: { readonly initial: string; readonly final: string; readonly stable: boolean; readonly harnessSha256?: string };
  readonly provenance?: Awaited<ReturnType<typeof import("./token-evaluation-provenance.js").evaluationProvenance>>;
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
  readonly assembly?: { readonly turnSetupMs: number; readonly requestAssemblyMs: number; readonly samples: number };
  readonly correctiveRounds?: number;
  readonly retriedToolCalls?: number;
  readonly protocolRepairs?: number;
  readonly failures?: readonly import("./token-evaluation-failures.js").EvaluationFailure[];
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
  if (![before, after].every((report) => report.snapshot?.stable && report.snapshot.initial === report.snapshot.final)) reasons.push("source-snapshot-unstable-or-unknown");
  if (!before.snapshot?.harnessSha256 || before.snapshot.harnessSha256 !== after.snapshot?.harnessSha256) reasons.push("harness-provenance-unknown-or-unmatched");
  if (wireHistoryStable(before.wires) !== true || wireHistoryStable(after.wires) !== true) reasons.push("history-prefix-unstable-or-unknown");
  if (JSON.stringify(before.route) !== JSON.stringify(after.route) || before.fixture !== after.fixture || before.repeat !== after.repeat) reasons.push("unmatched-pair");
  if (before.coverageGaps.length || after.coverageGaps.length) reasons.push("incomplete-coverage");
  if (!before.provenance || !after.provenance || before.provenance.fixtureSha256 !== after.provenance.fixtureSha256) reasons.push("fixture-provenance-unknown-or-unmatched");
  if (!summarizeAttempts(before.attempts).providerExact || !summarizeAttempts(after.attempts).providerExact) reasons.push("provider-token-precision-unknown");
  if (before.firstAttemptValidity === null || after.firstAttemptValidity === null || before.repairCalls === null || after.repairCalls === null) reasons.push("first-attempt-reliability-unknown");
  else if (after.firstAttemptValidity < before.firstAttemptValidity || after.repairCalls > before.repairCalls) reasons.push("first-attempt-reliability-regression");
  if (after.peakRssBytes > before.peakRssBytes || after.cpuMicroseconds > before.cpuMicroseconds) reasons.push("local-resource-regression");
  return { fixture: before.fixture, route: before.route, repeat: before.repeat, accepted: reasons.length === 0, reasons };
}
