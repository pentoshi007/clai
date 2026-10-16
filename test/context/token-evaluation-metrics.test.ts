import { describe, expect, it } from "vitest";
import { pairedRejectionReasons, summarizeAttempts, wirePrefixStable, type EvaluationAttempt, type EvaluationWire, type PairedGateInput } from "../../scripts/token-evaluation-metrics.js";
import { fingerprintFinalRequest } from "../../src/llm/request-fingerprint.js";
import { compareEvaluationReports, type EvaluationReport } from "../../scripts/token-evaluation-report.js";

const attempt = (overrides: Partial<EvaluationAttempt> = {}): EvaluationAttempt => ({
  ordinal: 1, purpose: "turn", route: { provider: "openai", model: "synthetic", mode: "stream", reason: "initial" },
  outcome: "success", usage: { promptTokens: 2000, completionTokens: 10, totalTokens: 2010, exact: true, cachedPromptTokens: 1000, cacheCreationTokens: 500 },
  elapsedMs: 10, fingerprint: null, statusCode: 200, ...overrides,
});
const gate: PairedGateInput = { passed: true, error: false, modelRounds: 3, toolCalls: 4, toolErrors: 0, blockedCalls: 0, prefixStable: true,
  elapsedMs: 200, firstTokenMs: 100, inputTokens: 10000, firstInputTokens: 2000, knownCacheHitRate: 0.9, eligiblePrefixReuse: 0.8 };
const improved = { ...gate, inputTokens: 8000, firstInputTokens: 1600 };
function wire(body: string): EvaluationWire {
  return { ordinal: 1, statusCode: 200, elapsedMs: 1, fingerprint: fingerprintFinalRequest({ provider: "openai", model: "synthetic" }, body) ?? null };
}

describe("complete evaluation metrics", () => {
  it("includes failed/auxiliary attempts and never turns unknown cache or usage into zero", () => {
    const values = [attempt(), attempt({ ordinal: 2, outcome: "failure", usage: null }), attempt({ ordinal: 3, purpose: "auxiliary" })];
    expect(summarizeAttempts(values)).toMatchObject({ attempts: 3, failures: 1, auxiliaryAttempts: 1, inputTokens: null, outputTokens: null,
      knownInputTokens: 4000, unknownUsageAttempts: 1, cachedInputTokens: null, cacheWriteTokens: null, providerExact: false });
    expect(summarizeAttempts([attempt({ usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6, exact: true } })]).cachedInputTokens).toBeNull();
    expect(summarizeAttempts([]).firstInputTokens).toBeNull();
  });

  it("detects changed prompt bytes, descriptions and ordered schemas on failed as well as successful requests", () => {
    const body = { model: "synthetic", messages: [{ role: "system", content: "stable" }, { role: "user", content: "first" }],
      tools: [{ type: "function", function: { name: "fs_read", description: "read" } }, { type: "function", function: { name: "http_fetch", description: "raw" } }] };
    const baseline = wire(JSON.stringify(body));
    expect(wirePrefixStable([baseline, wire(JSON.stringify({ ...body, messages: [...body.messages, { role: "assistant", content: "next" }] }))])).toBe(true);
    expect(wirePrefixStable([baseline, { ...wire(JSON.stringify({ ...body, tools: [...body.tools].reverse() })), statusCode: 500 }])).toBe(false);
    expect(wirePrefixStable([baseline, wire(JSON.stringify({ ...body, messages: [{ role: "system", content: "Stable" }] }))])).toBe(false);
    expect(wirePrefixStable([baseline, wire(JSON.stringify({ ...body, tools: [{ ...body.tools[0]!, function: { name: "fs_read", description: "changed" } }, body.tools[1]] }))])).toBe(false);
    expect(wirePrefixStable([])).toBeNull();
  });

  it("keeps partial trial reports ineligible even when their visible outcomes pass", () => {
    const report: EvaluationReport = {
      version: 1, fixture: "synthetic", variant: "before", repeat: 1,
      route: { provider: "openai", model: "synthetic", toolCalling: "native", thinking: { enabled: false, effort: "medium" } },
      passed: true, error: false, modelRounds: null, successfulModelRounds: 1, providerInvocations: 1, auxiliaryInvocations: 0,
      toolCalls: 0, toolErrors: 0, blockedCalls: 0, elapsedMs: 1, firstTokenMs: 1, peakRssBytes: 100, cpuMicroseconds: 100, observerOverheadMs: 0,
      attempts: [attempt()], usageSummary: summarizeAttempts([attempt()]), cost: null, firstAttemptValidity: null, repairCalls: null,
      wires: [], cache: { knownCacheHitRate: null, eligiblePrefixReuse: null, warmEligibleRequests: null },
      coverageGaps: ["unmeasured live cache"],
    };
    const result = compareEvaluationReports(report, { ...report, variant: "after" });
    expect(result.accepted).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining(["incomplete-coverage", "modelRounds-unknown", "eligiblePrefixReuse-unknown"]));
    expect(compareEvaluationReports(report, { ...report, fixture: "different" }).reasons).toContain("unmatched-pair");
  });

  it("rejects extra requests, missing evidence, latency regression and inconclusive cache data", () => {
    expect(pairedRejectionReasons(gate, improved)).toEqual([]);
    expect(pairedRejectionReasons(gate, { ...improved, modelRounds: 4 })).toContain("modelRounds-regression");
    expect(pairedRejectionReasons(gate, { ...improved, modelRounds: null })).toContain("modelRounds-unknown");
    for (const key of ["toolCalls", "toolErrors", "blockedCalls", "elapsedMs"] as const) {
      expect(pairedRejectionReasons(gate, { ...improved, [key]: gate[key] + 1 })).toContain(`${key}-regression`);
    }
    expect(pairedRejectionReasons(gate, { ...improved, passed: false })).toContain("unverified-outcome");
    expect(pairedRejectionReasons(gate, { ...improved, knownCacheHitRate: null })).toContain("knownCacheHitRate-unknown");
    expect(pairedRejectionReasons(gate, { ...improved, eligiblePrefixReuse: 0.6 })).toContain("eligiblePrefixReuse-regression");
    expect(pairedRejectionReasons(gate, { ...improved, firstTokenMs: 101 })).toContain("first-token-regression");
    expect(pairedRejectionReasons(gate, gate)).toContain("inputTokens-not-improved");
  });
});
