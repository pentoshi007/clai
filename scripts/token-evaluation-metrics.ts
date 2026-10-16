import type { AgentEvent } from "../src/agent/events.js";
import type { GenerationAttemptInput, GenerationAttemptOutcome, RequestFingerprintV1, TokenUsage } from "../src/types.js";

export interface EvaluationAttempt {
  readonly ordinal: number;
  readonly purpose: "turn" | "auxiliary";
  readonly route: Pick<GenerationAttemptInput, "provider" | "model" | "mode" | "reason">;
  readonly outcome: GenerationAttemptOutcome;
  readonly usage: TokenUsage | null;
  readonly elapsedMs: number;
  readonly fingerprint: RequestFingerprintV1 | null;
  readonly statusCode: number | null;
}
export interface EvaluationWire {
  readonly ordinal: number;
  readonly statusCode: number | null;
  readonly elapsedMs: number;
  readonly fingerprint: RequestFingerprintV1 | null;
}
const sumKnown = (values: readonly (number | null | undefined)[]): number | null =>
  values.length > 0 && values.every((value) => value !== null && value !== undefined) ? values.reduce<number>((sum, value) => sum + value!, 0) : null;

export function summarizeAttempts(attempts: readonly EvaluationAttempt[]) {
  const usage = attempts.map((attempt) => attempt.usage);
  return {
    attempts: attempts.length, successes: attempts.filter((attempt) => attempt.outcome === "success").length,
    failures: attempts.filter((attempt) => attempt.outcome === "failure").length,
    cancelled: attempts.filter((attempt) => attempt.outcome === "cancelled").length,
    auxiliaryAttempts: attempts.filter((attempt) => attempt.purpose === "auxiliary").length,
    unknownUsageAttempts: usage.filter((entry) => entry === null).length,
    providerExact: usage.length > 0 && usage.every((entry) => entry?.exact && entry.promptTokensKnown !== false),
    inputTokens: sumKnown(usage.map((entry) => entry?.promptTokensKnown === false ? null : entry?.promptTokens)),
    outputTokens: sumKnown(usage.map((entry) => entry?.completionTokens)),
    reasoningTokens: sumKnown(usage.map((entry) => entry?.reasoningTokens)),
    cachedInputTokens: sumKnown(usage.map((entry) => entry?.cachedPromptTokens)),
    cacheWriteTokens: sumKnown(usage.map((entry) => entry?.cacheCreationTokens)),
    knownInputTokens: usage.reduce((sum, entry) => sum + (entry?.promptTokensKnown === false ? 0 : entry?.promptTokens ?? 0), 0),
    knownOutputTokens: usage.reduce((sum, entry) => sum + (entry?.completionTokens ?? 0), 0),
    firstInputTokens: usage[0]?.promptTokensKnown === false ? null : usage[0]?.promptTokens ?? null,
  };
}

export function wirePrefixStable(wires: readonly EvaluationWire[]): boolean | null {
  if (wires.length === 0 || wires.some((wire) => wire.fingerprint === null)) return null;
  const serializers = new Set(wires.map((wire) => wire.fingerprint!.serializer.id));
  if (serializers.size !== 1) return null;
  const first = wires[0]!.fingerprint!;
  const digest = (fingerprint: RequestFingerprintV1, section: "instructions" | "tools") => fingerprint.sections.find((entry) => entry.section === section)?.sha256;
  const sections = ["instructions", "tools"] as const;
  const historyHead = (fingerprint: RequestFingerprintV1) => fingerprint.prefixes.find((entry) => entry.boundary === "history-item" && entry.historyItems === 1);
  const initialHead = historyHead(first);
  if (!initialHead && digest(first, "instructions") === undefined) return null;
  return wires.every((wire) => {
    const next = wire.fingerprint!;
    const nextHead = historyHead(next);
    return sections.every((section) => digest(next, section) === digest(first, section)) &&
      nextHead?.sha256 === initialHead?.sha256 && nextHead?.byteLength === initialHead?.byteLength;
  });
}

export class EvaluationEvents {
  toolCalls = 0;
  toolErrors = 0;
  blockedCalls = 0;
  firstVisibleTokenMs: number | null = null;
  readonly observedCalls: Array<{ name: string; turn: number }> = [];
  readonly turnStatuses: string[] = [];

  observe(event: AgentEvent, elapsedMs: number, turn: number): void {
    if (event.type === "assistant-delta" && event.text && this.firstVisibleTokenMs === null) this.firstVisibleTokenMs = elapsedMs;
    if (event.type === "tool-call") {
      this.toolCalls += 1;
      this.observedCalls.push({ name: event.name, turn });
    }
    if (event.type === "tool-result" && !event.ok) this.toolErrors += 1;
    if (event.type === "tool-blocked") this.blockedCalls += 1;
    if (event.type === "turn-end") this.turnStatuses.push(event.outcome.status);
  }
}

export interface PairedGateInput {
  readonly passed: boolean;
  readonly error: boolean;
  readonly modelRounds: number | null;
  readonly toolCalls: number;
  readonly toolErrors: number;
  readonly blockedCalls: number;
  readonly prefixStable: boolean | null;
  readonly elapsedMs: number;
  readonly firstTokenMs: number | null;
  readonly inputTokens: number | null;
  readonly firstInputTokens: number | null;
  readonly knownCacheHitRate: number | null;
  readonly eligiblePrefixReuse: number | null;
}
export function pairedRejectionReasons(before: PairedGateInput, after: PairedGateInput): string[] {
  const reasons: string[] = [];
  if (!before.passed || !after.passed) reasons.push("unverified-outcome");
  if (before.error || after.error) reasons.push("trial-error");
  if (before.prefixStable !== true || after.prefixStable !== true) reasons.push("prefix-unstable-or-unknown");
  if (before.modelRounds === null || after.modelRounds === null) reasons.push("modelRounds-unknown");
  else if (after.modelRounds > before.modelRounds) reasons.push("modelRounds-regression");
  for (const key of ["toolCalls", "toolErrors", "blockedCalls", "elapsedMs"] as const) {
    if (after[key] > before[key]) reasons.push(`${key}-regression`);
  }
  for (const key of ["inputTokens", "firstInputTokens"] as const) {
    if (before[key] === null || after[key] === null) reasons.push(`${key}-unknown`);
    else if (after[key] >= before[key]) reasons.push(`${key}-not-improved`);
  }
  if (before.firstTokenMs === null || after.firstTokenMs === null) reasons.push("first-token-unknown");
  else if (after.firstTokenMs > before.firstTokenMs) reasons.push("first-token-regression");
  for (const key of ["knownCacheHitRate", "eligiblePrefixReuse"] as const) {
    if (before[key] === null || after[key] === null) reasons.push(`${key}-unknown`);
    else if (after[key] < before[key]) reasons.push(`${key}-regression`);
  }
  return reasons;
}
