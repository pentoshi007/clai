import { buildModalLines, type DiffOp, type FileChange } from "../../tools/file-diff.js";

const CONTEXT_LINES = 3;

interface DiffRow {
  readonly op: DiffOp;
  readonly line: number | undefined;
  readonly text: string;
}

const diffTextCache = new WeakMap<FileChange, string>();

function hasCompleteDiff(change: FileChange): boolean {
  if (change.afterText === undefined || change.addedNewLines.length !== change.stats.added) return false;
  let removed = 0;
  for (const segment of change.deletedAt) removed += segment.lines.length;
  return removed === change.stats.removed;
}

function completeGroups(change: FileChange): DiffRow[][] {
  const rows: DiffRow[] = buildModalLines(change).map((line) => ({
    op: line.op,
    line: line.op === "del" ? line.oldLineNo : line.lineNo,
    text: line.text,
  }));
  const keep = new Uint8Array(rows.length);
  rows.forEach((row, index) => {
    if (row.op === "context") return;
    const end = Math.min(rows.length - 1, index + CONTEXT_LINES);
    for (let cursor = Math.max(0, index - CONTEXT_LINES); cursor <= end; cursor += 1) keep[cursor] = 1;
  });
  const groups: DiffRow[][] = [];
  let current: DiffRow[] | undefined;
  rows.forEach((row, index) => {
    if (!keep[index]) {
      current = undefined;
      return;
    }
    if (!current) {
      current = [];
      groups.push(current);
    }
    current.push(row);
  });
  return groups;
}

function previewGroups(change: FileChange): DiffRow[][] {
  return change.previewHunks.map((hunk) => hunk.lines.map((line) => ({
    op: line.op,
    line: line.op === "del" ? line.oldLine : line.newLine,
    text: line.text,
  })));
}

function formatSessionChangeDiff(change: FileChange): string {
  const complete = hasCompleteDiff(change);
  const groups = complete ? completeGroups(change) : previewGroups(change);
  let width = 1;
  let shown = 0;
  for (const group of groups) {
    for (const row of group) {
      if (row.line !== undefined) width = Math.max(width, String(row.line).length);
      if (row.op !== "context") shown += 1;
    }
  }
  const blank = " ".repeat(width);
  const out = [`${blank} │ ${change.kind} · ${change.path}`];
  groups.forEach((group, index) => {
    if (index > 0) out.push(`${blank} │ ⋯`);
    for (const row of group) {
      const mark = row.op === "add" ? "+" : row.op === "del" ? "−" : " ";
      const number = row.line === undefined ? blank : String(row.line).padStart(width, " ");
      out.push(`${number} │ ${mark} ${row.text}`);
    }
  });
  const hidden = change.stats.added + change.stats.removed - shown;
  if (!complete && hidden > 0) out.push(`${blank} │ ⋯ ${hidden} more changed line${hidden === 1 ? "" : "s"} not kept for this edit`);
  return out.join("\n");
}

export function sessionChangeDiff(change: FileChange): string {
  let text = diffTextCache.get(change);
  if (text === undefined) {
    text = formatSessionChangeDiff(change);
    diffTextCache.set(change, text);
  }
  return text;
}
