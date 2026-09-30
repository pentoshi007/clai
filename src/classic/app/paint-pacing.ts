export const PAINT_MIN_INTERVAL_MS = 50;
export const PAINT_MAX_INTERVAL_MS = 250;
export const PAINT_BUSY_SHARE_DIVISOR = 4;
const COST_SMOOTHING = 0.3;

export interface PaintPacing {
  readonly costMs: number;
  readonly intervalMs: number;
}

export const INITIAL_PAINT_PACING: PaintPacing = {
  costMs: 0,
  intervalMs: PAINT_MIN_INTERVAL_MS,
};

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}

export function nextPaintPacing(previous: PaintPacing, sampleMs: number): PaintPacing {
  const sample = Number.isFinite(sampleMs) ? Math.max(0, sampleMs) : 0;
  const costMs = previous.costMs + (sample - previous.costMs) * COST_SMOOTHING;
  const intervalMs = clamp(
    Math.ceil(costMs * PAINT_BUSY_SHARE_DIVISOR),
    PAINT_MIN_INTERVAL_MS,
    PAINT_MAX_INTERVAL_MS,
  );
  return { costMs, intervalMs };
}
