import type { Reducer, ReducerOutput } from "./types.js";

const LINE_RE = /^(?<path>\S+)\s+\(Status:\s*(?<status>\d+)\)\s+\[Size:\s*(?<size>\d+)\]/;

function isInterestingStatus(status: number): boolean {
  return status !== 404;
}

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
    return {
      summary:
        "# gobuster — no paths parsed. Prefer status filters at the command so the log is mostly hits.",
    };
  }
  const interestingStatuses = [...groups.keys()].filter(isInterestingStatus);
  const statuses =
    interestingStatuses.length > 0 &&
    interestingStatuses.length < groups.size
      ? interestingStatuses.sort((a, b) => a - b)
      : [...groups.keys()].sort((a, b) => a - b);
  const omitted404 =
    groups.has(404) && statuses.every((s) => s !== 404)
      ? groups.get(404)!.length
      : 0;
  const lines: string[] = [
    `# gobuster hits — ${statuses.length} status code(s)` +
      (omitted404 > 0
        ? ` (${omitted404}× 404 omitted from summary; full log on artifact if saved)`
        : ""),
  ];
  for (const status of statuses) {
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
    findings: { byStatus: Object.fromEntries(groups), omitted404 },
  };
};
