import type { Reducer, ReducerOutput } from "./types.js";

interface NucleiHit {
  "template-id"?: string;
  template?: string;
  info?: { severity?: string; name?: string };
  host?: string;
  "matched-at"?: string;
  matched?: string;
  type?: string;
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info", "unknown"] as const;

export const nucleiReducer: Reducer = (raw): ReducerOutput => {
  const hits: NucleiHit[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      hits.push(JSON.parse(trimmed) as NucleiHit);
    } catch {
      // skip malformed lines
    }
  }
  if (hits.length === 0) {
    return { summary: "# nuclei — no JSONL hits parsed (pass -jsonl to get structured output)" };
  }
  const bySeverity = new Map<string, NucleiHit[]>();
  for (const hit of hits) {
    const sev = hit.info?.severity?.toLowerCase() ?? "unknown";
    const list = bySeverity.get(sev) ?? [];
    list.push(hit);
    bySeverity.set(sev, list);
  }
  const counts = SEVERITY_ORDER
    .filter((sev) => bySeverity.has(sev))
    .map((sev) => `${sev}=${bySeverity.get(sev)!.length}`);
  const lines: string[] = [
    `# nuclei reduced summary — ${hits.length} hit(s) ${counts.join(" ")}`,
  ];
  for (const sev of SEVERITY_ORDER) {
    const list = bySeverity.get(sev);
    if (!list) continue;
    lines.push("");
    lines.push(`## ${sev.toUpperCase()} (${list.length})`);
    for (const hit of list.slice(0, 15)) {
      const id = hit["template-id"] ?? hit.template ?? "?";
      const name = hit.info?.name ?? "";
      const matched = hit["matched-at"] ?? hit.matched ?? hit.host ?? "?";
      lines.push(`- ${id}${name ? ` [${name}]` : ""} — ${matched}`);
    }
    if (list.length > 15) lines.push(`- ... ${list.length - 15} more`);
  }
  return {
    summary: lines.join("\n"),
    findings: { total: hits.length, bySeverity: Object.fromEntries([...bySeverity.entries()].map(([k, v]) => [k, v.length])) },
  };
};
