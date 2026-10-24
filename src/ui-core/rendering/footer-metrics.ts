import type { GenerationMetrics } from "../../llm/generation-metrics.js";
import type { ContextUsageSnapshot } from "../../llm/token-usage.js";
import { contextChipForDensity } from "./context-limit.js";
import { tokensPerSecondLabel } from "./duration.js";
import { statusDensityForWidth } from "./status-segments.js";
import { renderColumns } from "./text-width.js";

export function footerMetrics(
  usage: ContextUsageSnapshot,
  generation: GenerationMetrics | undefined,
  columns: number,
): { readonly context: string | undefined; readonly rate: string | undefined } {
  const density = statusDensityForWidth(columns);
  const chip = contextChipForDensity(usage, density);
  const context = density === "xs" || density === "sm" ? chip?.split("/")[0] : chip;
  const rate = tokensPerSecondLabel(generation);
  const available = Math.max(0, Math.floor(columns) - 9);
  if (rate && renderColumns(rate) <= available) {
    const fitsContext = context && renderColumns(`${rate} · ${context}`) <= available;
    return { rate, context: fitsContext ? context : undefined };
  }
  return {
    rate: undefined,
    context: context && renderColumns(context) <= available ? context : undefined,
  };
}
