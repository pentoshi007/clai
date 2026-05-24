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

/**
 * ffuf supports JSON output (`-of json`) but the default is plain text. We
 * parse both, group by status, and surface the most interesting clusters.
 */
export const ffufReducer: Reducer = (raw): ReducerOutput => {
  const results: FfufResult[] = [];
  // Try JSON first (works when the agent already used `-of json`).
  const jsonStart = raw.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart)) as FfufJson;
      if (parsed.results) {
        for (const r of parsed.results) results.push(r);
      }
    } catch {
      // fall through to text parsing
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
    return { summary: "# ffuf — no results parsed" };
  }

  // Cluster by (status, length) so likely-templated wildcard responses fold up.
  const clusters = new Map<
    string,
    { status?: number; length?: number; samples: FfufResult[] }
  >();
  for (const r of results) {
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
    `# ffuf reduced summary — ${results.length} result(s), ${clusters.size} (status,length) cluster(s)`,
  ];
  for (const c of sorted.slice(0, 25)) {
    lines.push("");
    lines.push(
      `## status=${c.status ?? "?"} length=${c.length ?? "?"} — ${c.samples.length} hit(s)`,
    );
    for (const sample of c.samples.slice(0, 5)) {
      lines.push(`- ${sample.url ?? JSON.stringify(sample.input)}`);
    }
    if (c.samples.length > 5) {
      lines.push(`- ... ${c.samples.length - 5} more`);
    }
  }
  return {
    summary: lines.join("\n"),
    findings: {
      total: results.length,
      clusters: sorted.map((c) => ({
        status: c.status,
        length: c.length,
        count: c.samples.length,
      })),
    },
  };
};
