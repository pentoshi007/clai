import type {
  CompactedItem,
  ThinkingItem,
  ToolItem,
} from "../state/transcript-types.js";

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

function elapsedLabel(
  item: {
    readonly timestamp: number;
    readonly startedAt?: number | undefined;
    readonly endedAt?: number | undefined;
  },
  now: number,
  live: boolean,
): string | undefined {
  const start = item.startedAt ?? item.timestamp;
  const end = live ? now : item.endedAt;
  if (end === undefined) return undefined;
  const label = formatDurationMs(end - start);
  return label === "" ? undefined : label;
}

export function thinkingElapsedLabel(
  item: Pick<
    ThinkingItem,
    "streaming" | "timestamp" | "startedAt" | "endedAt"
  >,
  now: number,
): string | undefined {
  return elapsedLabel(item, now, item.streaming);
}

export function compactionElapsedLabel(
  item: Pick<
    CompactedItem,
    "streaming" | "timestamp" | "startedAt" | "endedAt"
  >,
  now: number,
): string | undefined {
  return elapsedLabel(item, now, item.streaming === true);
}

export function shouldShowToolElapsed(toolName: string): boolean {
  return !toolName.startsWith("fs.") || toolName === "fs.search";
}

export function toolElapsedLabel(
  item: Pick<ToolItem, "name" | "status" | "timestamp" | "startedAt" | "endedAt">,
  now: number,
): string | undefined {
  if (!shouldShowToolElapsed(item.name)) return undefined;
  if (item.status === "blocked" || item.status === "queued") return undefined;
  const start = item.startedAt ?? item.timestamp;
  const span =
    item.status === "running"
      ? now - start
      : item.endedAt === undefined
        ? -1
        : item.endedAt - start;
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
