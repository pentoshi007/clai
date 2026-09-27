export interface ProviderContextMeasurement {
  readonly measuredTokens: number;
  readonly estimatedTokens: number;
}

function positiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const floored = Math.floor(value);
  return floored > 0 ? floored : undefined;
}

export function providerContextMeasurement(
  measuredTokens: number | undefined,
  estimatedTokens: number,
): ProviderContextMeasurement | undefined {
  const measured = positiveInteger(measuredTokens);
  const estimated = positiveInteger(estimatedTokens);
  if (measured === undefined || estimated === undefined) return undefined;
  return { measuredTokens: measured, estimatedTokens: estimated };
}

export function projectMeasuredTokens(
  measurement: ProviderContextMeasurement,
  estimatedTokens: number,
): number {
  if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) return 0;
  return Math.max(
    1,
    Math.round(
      measurement.measuredTokens * (estimatedTokens / measurement.estimatedTokens),
    ),
  );
}
