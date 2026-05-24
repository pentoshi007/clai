import type { Reducer, ReducerOutput } from "./types.js";

interface HttpxRow {
  url?: string;
  input?: string;
  host?: string;
  status_code?: number;
  status?: number;
  title?: string;
  webserver?: string;
  tech?: string[];
  technologies?: string[];
  content_length?: number;
  cdn?: string;
  cdn_name?: string;
  final_url?: string;
}

export const httpxReducer: Reducer = (raw): ReducerOutput => {
  const rows: HttpxRow[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      rows.push(JSON.parse(trimmed) as HttpxRow);
    } catch {
      // skip malformed lines
    }
  }
  if (rows.length === 0) {
    return { summary: "# httpx — no JSONL rows parsed (pass -json to get structured output)" };
  }
  const lines: string[] = [
    `# httpx reduced summary — ${rows.length} URL(s)`,
  ];
  for (const row of rows.slice(0, 50)) {
    const url = row.final_url ?? row.url ?? row.input ?? row.host ?? "?";
    const status = row.status_code ?? row.status ?? "?";
    const tech = (row.tech ?? row.technologies ?? []).join(", ");
    const title = row.title ? ` title=${JSON.stringify(row.title)}` : "";
    const cdn = row.cdn_name ?? row.cdn;
    const cdnNote = cdn ? ` cdn=${cdn}` : "";
    const len = row.content_length !== undefined ? ` len=${row.content_length}` : "";
    lines.push(`- ${url} [${status}]${title}${len}${tech ? ` tech=[${tech}]` : ""}${cdnNote}`);
  }
  if (rows.length > 50) {
    lines.push(`- ... ${rows.length - 50} more in artifact`);
  }
  return {
    summary: lines.join("\n"),
    findings: { count: rows.length },
  };
};
