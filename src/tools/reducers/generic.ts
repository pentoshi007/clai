import type { Reducer, ReducerOutput } from "./types.js";

/**
 * Catch-all reducer that ranks lines by signal so important findings survive
 * truncation. Used when no command-specific reducer matches.
 */
const SIGNAL_PATTERNS: Array<{ tag: string; re: RegExp; weight: number }> = [
  { tag: "credential", re: /\b(?:password|passwd|secret|token|api[_-]?key|bearer)\b/i, weight: 5 },
  { tag: "vulnerable", re: /\b(?:vulnerable|exploitable|exploit|cve-\d{4}-\d+)/i, weight: 5 },
  { tag: "error", re: /\b(?:error|failed|denied|forbidden|refused|fatal)\b/i, weight: 4 },
  { tag: "success", re: /\b(?:found|success|matched|positive|admin)\b/i, weight: 3 },
  { tag: "open-port", re: /\b\d+\/(?:tcp|udp)\s+open\b/i, weight: 3 },
  { tag: "http-2xx", re: /\s2\d{2}\b/, weight: 2 },
  { tag: "http-403", re: /\s403\b/, weight: 2 },
  { tag: "warning", re: /\bwarning\b/i, weight: 1 },
];

function scoreLine(line: string): { score: number; tags: string[] } {
  let score = 0;
  const tags: string[] = [];
  for (const pattern of SIGNAL_PATTERNS) {
    if (pattern.re.test(line)) {
      score += pattern.weight;
      tags.push(pattern.tag);
    }
  }
  return { score, tags };
}

export const genericReducer: Reducer = (raw, _ctx): ReducerOutput => {
  const lines = raw.split(/\r?\n/);
  const scored = lines.map((line, index) => ({
    line,
    index,
    ...scoreLine(line),
  }));
  const interesting = scored.filter((x) => x.score > 0);
  const totalLines = lines.length;
  if (interesting.length === 0) {
    // Fall back to head + tail when nothing matched.
    const head = lines.slice(0, 20).join("\n");
    const tail = lines.slice(-10).join("\n");
    return {
      summary: head + (lines.length > 30 ? `\n... (${lines.length} lines total)\n` : "\n") + tail,
    };
  }
  const topRanked = interesting
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 40);
  const lineSet = new Set(topRanked.map((x) => x.index));
  // Always include the very last 5 lines so trailing summaries (e.g. "X hosts
  // up", "scan complete") are not dropped.
  for (let i = Math.max(0, lines.length - 5); i < lines.length; i++) {
    lineSet.add(i);
  }
  const ordered = [...lineSet].sort((a, b) => a - b);
  const summaryLines = ordered.map((i) => lines[i]).filter((l): l is string => l !== undefined);
  const dropped = totalLines - ordered.length;
  const header = `# Reduced output (${ordered.length} of ${totalLines} lines, ${dropped} omitted)`;
  return {
    summary: [header, ...summaryLines].join("\n"),
  };
};
