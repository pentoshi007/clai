import { MAX_FS_READ_FILES } from "./read-input.js";

export interface FsReadSection {
  readonly index: number;
  readonly total: number;
  readonly path: string;
  readonly ok: boolean;
  readonly body: string;
}

const HEADER = /^# fs\.read file=(\d+)\/(\d+) path=("(?:\\.|[^"\\])*") status=(ok|failed)$/m;

export function formatFsReadSection(section: FsReadSection): string {
  return `# fs.read file=${section.index}/${section.total} path=${JSON.stringify(section.path)} status=${section.ok ? "ok" : "failed"}\n${section.body}\n# end fs.read file=${section.index}/${section.total}`;
}

export function parseFsReadSections(output: string): FsReadSection[] {
  const sections: FsReadSection[] = [];
  const pattern = new RegExp(HEADER.source, "gm");
  let header: RegExpExecArray | null;
  while (sections.length < MAX_FS_READ_FILES && (header = pattern.exec(output))) {
    const index = Number(header[1]);
    const total = Number(header[2]);
    if (total < 1 || total > MAX_FS_READ_FILES || index < 1 || index > total) continue;
    let path: string;
    try { path = JSON.parse(header[3]!) as string; } catch { continue; }
    const start = header.index! + header[0].length + 1;
    const endMarker = `\n# end fs.read file=${index}/${total}`;
    const marker = output.indexOf(endMarker, start);
    const next = marker < 0 ? pattern.exec(output) : undefined;
    const end = marker >= start ? marker : next?.index ?? output.length;
    pattern.lastIndex = marker >= start ? marker + endMarker.length : end;
    sections.push({ index, total, path, ok: header[4] === "ok", body: output.slice(start, end).trimEnd() });
  }
  return sections;
}

export function isFsReadMultiOutput(output: string): boolean {
  return HEADER.test(output);
}

export function boundFsReadOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output;
  const sections = parseFsReadSections(output);
  if (sections.length === 0) return output;
  const prefix = output.slice(0, HEADER.exec(output)?.index ?? 0);
  const notice = "\n# Output clipped; re-read this path with narrower filters. Coverage is incomplete.\n";
  const pathBudget = Math.max(32, Math.floor(maxChars / (sections.length * 4)));
  const bounded = sections.map((section) => ({
    ...section,
    path: section.path.length <= pathBudget ? section.path : `${section.path.slice(0, pathBudget - 1)}…`,
  }));
  const headersSize = prefix.length + bounded.reduce((size, section) => size + formatFsReadSection({ ...section, body: "" }).length + 2, 0);
  if (headersSize >= maxChars) {
    const note = "\nBodies omitted; coverage is incomplete. Re-read with narrower filters.";
    const available = Math.max(0, maxChars - prefix.length - note.length);
    const rowBudget = Math.max(0, Math.floor(available / sections.length) - 1);
    const rows = sections.map((section) => {
      const label = `${section.index}/${section.total} ${section.ok ? "ok" : "failed"}: `;
      return `${label}${section.path.slice(0, Math.max(0, rowBudget - label.length))}`.slice(0, rowBudget);
    });
    return `${prefix}${rows.join("\n")}${note}`.slice(0, maxChars);
  }
  const budget = Math.max(0, Math.floor((maxChars - headersSize) / bounded.length));
  return prefix + bounded.map((section) => {
    if (section.body.length <= budget) return formatFsReadSection(section);
    if (budget <= notice.length) return formatFsReadSection({ ...section, body: notice.trim().slice(0, budget) });
    const contentBudget = budget - notice.length;
    const head = Math.ceil(contentBudget * 0.7);
    const tail = contentBudget - head;
    return formatFsReadSection({ ...section, body: `${section.body.slice(0, head)}${notice}${tail > 0 ? section.body.slice(-tail) : ""}` });
  }).join("\n\n");
}
