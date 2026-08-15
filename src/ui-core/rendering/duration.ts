import type { ToolItem } from "../state/transcript-types.js";

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m${String(whole % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function toolElapsedLabel(
  item: Pick<ToolItem, "status" | "timestamp" | "endedAt">,
  now: number,
): string | undefined {
  if (item.status === "blocked") return undefined;
  const open = item.status === "running" || item.status === "queued";
  const span = open
    ? now - item.timestamp
    : item.endedAt === undefined
      ? -1
      : item.endedAt - item.timestamp;
  const label = formatDurationMs(span);
  return label === "" ? undefined : label;
}

export function turnSummaryLabel(
  durationMs: number,
  status: "completed" | "aborted" | "error",
): string {
  const base = `Worked for ${formatDurationMs(durationMs)}`;
  if (status === "aborted") return `${base} · aborted`;
  if (status === "error") return `${base} · error`;
  return base;
}
