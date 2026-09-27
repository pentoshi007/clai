import type { TokenUsage } from "../types.js";

export const PROVIDER_RATIO_SOURCE = "provider-ratio" as const;

export function providerRatioPromptTokens(
  percentUsed: unknown,
  windowTokens: number | undefined,
): number | undefined {
  if (typeof percentUsed !== "number" || !Number.isFinite(percentUsed)) return undefined;
  if (percentUsed <= 0) return undefined;
  if (
    windowTokens === undefined ||
    !Number.isFinite(windowTokens) ||
    windowTokens <= 0
  ) {
    return undefined;
  }
  const window = Math.floor(windowTokens);
  const ratio = Math.min(percentUsed, 100) / 100;
  return Math.min(window, Math.max(1, Math.round(ratio * window)));
}

export function providerRatioUsage(input: {
  readonly percentUsed: unknown;
  readonly windowTokens: number | undefined;
  readonly completionTokens?: number | undefined;
}): TokenUsage | undefined {
  const promptTokens = providerRatioPromptTokens(
    input.percentUsed,
    input.windowTokens,
  );
  if (promptTokens === undefined) return undefined;
  const completionTokens =
    input.completionTokens !== undefined &&
    Number.isFinite(input.completionTokens) &&
    input.completionTokens > 0
      ? Math.floor(input.completionTokens)
      : 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    exact: false,
    promptTokensSource: PROVIDER_RATIO_SOURCE,
    contextWindowTokens: Math.floor(input.windowTokens!),
  };
}

export function isProviderMeasuredPrompt(usage: TokenUsage): boolean {
  if (usage.promptTokensKnown === false || usage.promptTokens <= 0) return false;
  return usage.exact || usage.promptTokensSource === PROVIDER_RATIO_SOURCE;
}
