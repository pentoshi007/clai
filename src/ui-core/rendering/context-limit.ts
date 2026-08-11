import type { ContextUsageSnapshot } from "../../llm/token-usage.js";

export type StatusDensity = "xs" | "sm" | "md" | "lg";

export const MIN_CONTEXT_LIMIT_TOKENS = 20_000;

export function formatContextK(n: number): string {
  const v = Math.max(0, Math.floor(n));
  if (v < 1000) return String(v);
  if (v < 1_000_000) {
    const k = v / 1000;
    if (k >= 100) {
      const r = Math.round(k);
      return r >= 1000 ? "1M" : `${r}k`;
    }
    return `${k.toFixed(1).replace(/\.0$/, "")}k`;
  }
  const m = v / 1_000_000;
  if (m >= 100) return `${Math.round(m)}M`;
  return `${m.toFixed(1).replace(/\.0$/, "")}M`;
}

export function contextChipForDensity(
  usage: ContextUsageSnapshot | undefined,
  _density: StatusDensity,
): string | undefined {
  if (!usage) return undefined;
  const used = formatContextK(usage.contextTokens);
  return usage.contextLimit > 0
    ? `ctx ${used}/${formatContextK(usage.contextLimit)}`
    : `ctx ${used}`;
}

export function parseContextLimitInput(value: string): number | undefined | null {
  const text = value.trim().toLowerCase().replace(/,/g, "");
  if (!text) return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  const scale = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  const tokens = Math.floor(amount * scale);
  return Number.isFinite(tokens) && tokens >= MIN_CONTEXT_LIMIT_TOKENS ? tokens : null;
}

export type ContextUsageSeverity = "normal" | "warn" | "critical";

export function contextUsageSeverity(
  usage: ContextUsageSnapshot | undefined,
): ContextUsageSeverity {
  if (!usage || usage.contextLimit <= 0) return "normal";
  const ratio = usage.contextTokens / usage.contextLimit;
  if (ratio >= 0.85) return "critical";
  if (ratio >= 0.6) return "warn";
  return "normal";
}
