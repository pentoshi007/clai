import type { Reducer, ReducerOutput } from "./types.js";

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * Reducer for subfinder / amass / sublist3r output. Dedup, normalize,
 * sort. The user can still pull the raw list from the artifact.
 */
export const subdomainsReducer: Reducer = (raw): ReducerOutput => {
  const set = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const token = line.trim();
    if (DOMAIN_RE.test(token)) {
      set.add(token.toLowerCase());
    }
  }
  if (set.size === 0) {
    return { summary: "# subdomains — none parsed from output" };
  }
  const sorted = [...set].sort();
  const preview = sorted.slice(0, 200);
  const lines: string[] = [
    `# subdomain enumeration — ${sorted.length} unique domain(s)`,
    ...preview,
  ];
  if (sorted.length > preview.length) {
    lines.push(`... ${sorted.length - preview.length} more in artifact`);
  }
  return {
    summary: lines.join("\n"),
    findings: { count: sorted.length, sample: preview },
  };
};
