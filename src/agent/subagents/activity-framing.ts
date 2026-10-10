import type { SubagentEvent } from "./types.js";

const MARKER_SOURCE = String.raw`### Attempt (\d+) · (\d+) · (assistant|tool|notice)( · escaped)?`;
const HEADER = new RegExp(`^${MARKER_SOURCE}$`);
const ESCAPABLE_MARKER = new RegExp(String.raw`^(\\*${MARKER_SOURCE})$`, "gm");
const ESCAPED_MARKER = new RegExp(String.raw`^\\+${MARKER_SOURCE}$`);

export function formatSubagentActivityHeader(attempt: number, event: SubagentEvent): string {
  return `### Attempt ${attempt} · ${event.sequence} · ${event.kind} · escaped`;
}

export function parseSubagentActivityHeader(line: string): {
  attempt: number;
  sequence: number;
  kind: SubagentEvent["kind"];
  escaped: boolean;
} | undefined {
  const match = HEADER.exec(line);
  return match ? {
    attempt: Number(match[1]),
    sequence: Number(match[2]),
    kind: match[3] as SubagentEvent["kind"],
    escaped: match[4] !== undefined,
  } : undefined;
}

export function escapeSubagentActivityText(text: string): string {
  return text.replace(ESCAPABLE_MARKER, "\\$1");
}

export function unescapeSubagentActivityLine(line: string): string {
  return ESCAPED_MARKER.test(line) ? line.slice(1) : line;
}
