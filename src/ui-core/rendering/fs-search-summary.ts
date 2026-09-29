export interface FsSearchSummary {
  readonly pattern: string | undefined;
  readonly path: string | undefined;
  readonly hits: number;
  readonly files: number;
  readonly capped: string | undefined;
  readonly notes: readonly string[];
  readonly body: readonly string[];
}

const HEADER = /^#\s*fs\.search\s+(.*)$/;
const HIT = /^(.+?):(\d+):/;

function headerField(header: string, key: string): string | undefined {
  const quoted = new RegExp(`\\b${key}=("(?:[^"\\\\]|\\\\.)*")`).exec(header);
  if (quoted) {
    try {
      return JSON.parse(quoted[1]!) as string;
    } catch {
      return quoted[1]!.slice(1, -1);
    }
  }
  const bare = new RegExp(`\\b${key}=(.*?)(?=\\s+\\w+=|\\s+\\(|$)`).exec(header);
  return bare?.[1]?.trim() || undefined;
}

export function presentFsSearchOutput(output: string, pattern?: string): FsSearchSummary {
  const lines = output.replace(/\r\n?/g, "\n").split("\n");
  let header: string | undefined;
  const notes: string[] = [];
  const body: string[] = [];
  for (const line of lines) {
    const head = HEADER.exec(line);
    if (head) {
      header = head[1] ?? "";
      continue;
    }
    if (/^#\s*note:/i.test(line)) {
      notes.push(line.replace(/^#\s*note:\s*/i, ""));
      continue;
    }
    if (/^#\s*(tip:|no matches)/i.test(line)) continue;
    if (line.trim() === "") continue;
    body.push(line);
  }
  const files = new Set<string>();
  for (const line of body) {
    const hit = HIT.exec(line);
    if (hit) files.add(hit[1]!);
  }
  if (files.size === 0) for (const line of body) files.add(line);
  const counted = header ? Number(headerField(header, "hits")) : Number.NaN;
  const capped = header ? /\(capped at (\d+)\)/.exec(header)?.[1] : undefined;
  return {
    pattern: (header ? headerField(header, "pattern") : undefined) ?? (pattern?.trim() || undefined),
    path: header ? headerField(header, "path") : undefined,
    hits: Number.isFinite(counted) ? counted : body.length,
    files: files.size,
    capped,
    notes,
    body,
  };
}

export function fsSearchHitsLabel(summary: FsSearchSummary): string {
  if (summary.hits === 0) return "no matches";
  const hits = `${summary.hits.toLocaleString()} hit${summary.hits === 1 ? "" : "s"}`;
  const files = summary.files > 0 ? ` in ${summary.files.toLocaleString()} file${summary.files === 1 ? "" : "s"}` : "";
  return `${hits}${files}${summary.capped ? ` (capped at ${summary.capped})` : ""}`;
}
