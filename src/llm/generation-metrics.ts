import type { CompletionResult, TokenUsage } from "../types.js";

export interface GenerationMetrics {
  readonly outputTokens: number;
  readonly durationMs: number;
}

export interface GenerationProgress extends GenerationMetrics {
  readonly estimated?: true | undefined;
}

const interruptedGenerations = new WeakMap<object, GenerationMetrics>();

export function validGenerationMetrics(value: unknown): value is GenerationMetrics {
  if (typeof value !== "object" || value === null) return false;
  const metrics = value as Record<string, unknown>;
  return typeof metrics.outputTokens === "number" &&
    Number.isSafeInteger(metrics.outputTokens) && metrics.outputTokens >= 0 &&
    typeof metrics.durationMs === "number" &&
    Number.isFinite(metrics.durationMs) && metrics.durationMs > 0;
}

function reportedGenerationMetrics(
  usage: TokenUsage | undefined,
  durationMs: number | undefined,
): GenerationMetrics | undefined {
  if (!usage?.exact) return undefined;
  const metrics = { outputTokens: usage.completionTokens, durationMs };
  return validGenerationMetrics(metrics) ? metrics : undefined;
}

export function completionGenerationMetrics(completion: CompletionResult): GenerationMetrics | undefined {
  return reportedGenerationMetrics(completion.usage, completion.generationDurationMs);
}

export function recordInterruptedGeneration(error: unknown, usage: TokenUsage | undefined, durationMs: number): void {
  if (!error || typeof error !== "object" || interruptedGenerations.has(error)) return;
  const metrics = reportedGenerationMetrics(usage, durationMs);
  if (metrics) interruptedGenerations.set(error, metrics);
}

export function interruptedGenerationMetrics(error: unknown): GenerationMetrics | undefined {
  const visited = new Set<object>();
  let current = error;
  while (current && typeof current === "object" && !visited.has(current)) {
    const metrics = interruptedGenerations.get(current);
    if (metrics) return metrics;
    visited.add(current);
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

export function addGenerationMetrics(
  previous: GenerationMetrics | null | undefined,
  next: GenerationMetrics | undefined,
): GenerationMetrics | null {
  if (previous === null || !validGenerationMetrics(next)) return null;
  const total = {
    outputTokens: (previous?.outputTokens ?? 0) + next.outputTokens,
    durationMs: (previous?.durationMs ?? 0) + next.durationMs,
  };
  return validGenerationMetrics(total) ? total : null;
}

export function generationTokensPerSecond(metrics: GenerationMetrics | undefined): number | undefined {
  if (!validGenerationMetrics(metrics) || metrics.outputTokens === 0) return undefined;
  const rate = metrics.outputTokens / (metrics.durationMs / 1_000);
  return Number.isFinite(rate) ? rate : undefined;
}
