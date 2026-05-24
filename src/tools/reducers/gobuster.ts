import type { Reducer, ReducerOutput } from "./types.js";

const LINE_RE = /^(?<path>\S+)\s+\(Status:\s*(?<status>\d+)\)\s+\[Size:\s*(?<size>\d+)\]/;

export const gobusterReducer: Reducer = (raw): ReducerOutput => {
  const groups = new Map<number, Array<{ path: string; size: number }>>();
  for (const line of raw.split(/\r?\n/)) {
    const match = LINE_RE.exec(line);
    if (!match || !match.groups) continue;
    const status = Number(match.groups.status);
    const path = match.groups.path!;
    const size = Number(match.groups.size);
    const list = groups.get(status) ?? [];
    list.push({ path, size });
    groups.set(status, list);
  }
  if (groups.size === 0) {
    return { summary: "# gobuster — no paths discovered" };
  }
  const sortedStatuses = [...groups.keys()].sort((a, b) => a - b);
  const lines: string[] = [`# gobuster reduced summary — ${sortedStatuses.length} status code(s)`];
  for (const status of sortedStatuses) {
    const entries = groups.get(status)!;
    lines.push("");
    lines.push(`## Status ${status} — ${entries.length} path(s)`);
    for (const entry of entries.slice(0, 25)) {
      lines.push(`- ${entry.path} (size=${entry.size})`);
    }
    if (entries.length > 25) {
      lines.push(`- ... ${entries.length - 25} more`);
    }
  }
  return {
    summary: lines.join("\n"),
    findings: { byStatus: Object.fromEntries(groups) },
  };
};
