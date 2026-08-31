import type { Reducer, ReducerOutput } from "./types.js";

interface FfufResult {
  url?: string | undefined;
  status?: number | undefined;
  length?: number | undefined;
  words?: number | undefined;
  lines?: number | undefined;
  input?: Record<string, string> | undefined;
}

interface FfufJson {
  results?: FfufResult[];
  commandline?: string;
  config?: { url?: string };
}

const LINE_RE =
  /^([^\s]+)\s+\[Status:\s*(\d+),\s*Size:\s*(\d+),\s*Words:\s*(\d+),\s*Lines:\s*(\d+).*\]/;

function isInterestingStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 404 || status === 429) return false;
  return true;
}

export const ffufReducer: Reducer = (raw): ReducerOutput => {
  const results: FfufResult[] = [];
  const jsonStart = raw.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart)) as FfufJson;
      if (parsed.results) {
        for (const r of parsed.results) results.push(r);
      }
    } catch {
    }
  }
  if (results.length === 0) {
    for (const line of raw.split(/\r?\n/)) {
      const match = LINE_RE.exec(line);
      if (!match) continue;
      results.push({
        url: match[1],
        status: Number(match[2]),
        length: Number(match[3]),
        words: Number(match[4]),
        lines: Number(match[5]),
      });
    }
  }

  if (results.length === 0) {
    return {
      summary:
        "# ffuf — no hit lines parsed (empty match set, or output not yet flushed). " +
        "Prefer -mc/-fc at the command so only interesting statuses are emitted. Full log is on the job/artifact if this was backgrounded.",
    };
  }

  const interesting = results.filter((r) => isInterestingStatus(r.status));
  const used =
    interesting.length > 0 && interesting.length < results.length
      ? interesting
      : results;
  const dropped404 = results.length - used.length;

  const clusters = new Map<
    string,
    { status?: number; length?: number; samples: FfufResult[] }
  >();
  for (const r of used) {
    const key = `${r.status ?? "?"}:${r.length ?? "?"}`;
    const c =
      clusters.get(key) ??
      ({ status: r.status, length: r.length, samples: [] } as {
        status?: number;
        length?: number;
        samples: FfufResult[];
      });
    c.samples.push(r);
    clusters.set(key, c);
  }
  const sorted = [...clusters.values()].sort(
    (a, b) => b.samples.length - a.samples.length,
  );
  const lines: string[] = [
    `# ffuf hits — ${used.length} interesting result(s)` +
      (dropped404 > 0
        ? ` (${dropped404}× 404/noise omitted from summary; full log on artifact if saved)`
        : "") +
      `, ${clusters.size} (status,length) cluster(s)`,
  ];
  for (const c of sorted.slice(0, 25)) {
    lines.push("");
    lines.push(
      `## status=${c.status ?? "?"} length=${c.length ?? "?"} — ${c.samples.length} hit(s)`,
    );
    for (const sample of c.samples.slice(0, 8)) {
      lines.push(`- ${sample.url ?? JSON.stringify(sample.input)}`);
    }
    if (c.samples.length > 8) {
      lines.push(`- ... ${c.samples.length - 8} more`);
    }
  }
  return {
    summary: lines.join("\n"),
    findings: {
      total: results.length,
      shown: used.length,
      droppedNoise: dropped404,
      clusters: sorted.map((c) => ({
        status: c.status,
        length: c.length,
        count: c.samples.length,
      })),
    },
  };
};
