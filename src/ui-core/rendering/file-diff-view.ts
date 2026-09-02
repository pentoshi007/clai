
import { relative } from "node:path";
import type {
  DiffLine,
  DiffOp,
  FileChange,
  ModalDiffLine,
} from "../../tools/file-diff.js";
import {
  buildModalLines,
  formatUnifiedPreview,
} from "../../tools/file-diff.js";
import { getActiveProjectRoot } from "../../agent/project-root.js";
import { safeCwd } from "../../os/cwd.js";
import type { Theme } from "./theme.js";
import {
  emptyCarry,
  highlightLineForPath,
  type LangId,
  type SyntaxKind,
  type SyntaxSpan,
} from "./syntax-highlight.js";

export type DiffLineTone = "context" | "add" | "del" | "gap" | "header";

export interface PresentedDiffRow {
  readonly tone: DiffLineTone;
  readonly gutter: string;
  readonly prefix: string;
  readonly text: string;
  readonly displayText: string;
  readonly spans: readonly SyntaxSpan[];
}

const DEFAULT_WRAP = 72;

function gutterWidth(change: FileChange): number {
  let max = 1;
  for (const h of change.previewHunks) {
    for (const l of h.lines) {
      const n = l.newLine ?? l.oldLine ?? 0;
      if (n > max) max = n;
    }
  }
  for (const n of change.addedNewLines) {
    if (n > max) max = n;
  }
  return String(max).length;
}

function lineGutter(dl: DiffLine, width: number): string {
  const n =
    dl.op === "del"
      ? dl.oldLine
      : dl.newLine ?? dl.oldLine;
  if (typeof n !== "number") return " ".repeat(width);
  return String(n).padStart(width, " ");
}

function prefixFor(op: DiffOp): string {
  if (op === "add") return "+";
  if (op === "del") return "−";
  return " ";
}

export function wrapCodeLine(text: string, max: number): string[] {
  const width = Math.max(8, max);
  if (text.length <= width) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += width) {
    out.push(text.slice(i, i + width));
  }
  return out.length > 0 ? out : [""];
}

function sliceSpans(
  spans: readonly SyntaxSpan[],
  start: number,
  end: number,
): SyntaxSpan[] {
  if (end <= start) return [];
  const out: SyntaxSpan[] = [];
  let cursor = 0;
  for (const s of spans) {
    const sStart = cursor;
    const sEnd = cursor + s.text.length;
    cursor = sEnd;
    if (sEnd <= start || sStart >= end) continue;
    const from = Math.max(0, start - sStart);
    const to = Math.min(s.text.length, end - sStart);
    if (to > from) {
      out.push({ kind: s.kind, text: s.text.slice(from, to) });
    }
  }
  return out;
}

export function syntaxColor(kind: SyntaxKind, theme: Theme): string {
  switch (kind) {
    case "keyword":
      return theme.synKeyword;
    case "string":
      return theme.synString;
    case "comment":
      return theme.synComment;
    case "number":
      return theme.synNumber;
    case "function":
      return theme.synFunction;
    case "type":
      return theme.synType;
    case "property":
      return theme.synProperty;
    case "operator":
      return theme.synOperator;
    case "regex":
      return theme.synRegex;
    case "punctuation":
      return theme.muted;
    default:
      return theme.foreground;
  }
}

export function rowBackground(
  tone: DiffLineTone,
  theme: Theme,
): string | undefined {
  if (tone === "add") return theme.diffAddBg;
  if (tone === "del") return theme.diffDelBg;
  return undefined;
}

export function presentFileChangePreview(
  change: FileChange,
  options: { maxLineChars?: number; maxRows?: number } = {},
): PresentedDiffRow[] {
  const maxLineChars = options.maxLineChars ?? DEFAULT_WRAP;
  const maxRows = options.maxRows ?? 80;
  const rows: PresentedDiffRow[] = [];
  const carry = emptyCarry();

  if (change.binary) {
    rows.push({
      tone: "header",
      gutter: "",
      prefix: " ",
      text: `binary · ${change.basename}`,
      displayText: `binary · ${change.basename}`,
      spans: [{ kind: "plain", text: `binary · ${change.basename}` }],
    });
    return rows;
  }

  const width = gutterWidth(change);
  let used = 0;

  for (const hunk of change.previewHunks) {
    if (used >= maxRows) break;
    for (const dl of hunk.lines) {
      if (used >= maxRows) break;
      const text = dl.text;
      const fullSpans = highlightLineForPath(text, change.path, carry);
      const chunks = wrapCodeLine(text, maxLineChars);
      let offset = 0;
      for (let ci = 0; ci < chunks.length; ci += 1) {
        if (used >= maxRows) break;
        const chunk = chunks[ci]!;
        const end = offset + chunk.length;
        const spans = sliceSpans(fullSpans, offset, end);
        rows.push({
          tone: dl.op,
          gutter: ci === 0 ? lineGutter(dl, width) : " ".repeat(width),
          prefix: ci === 0 ? prefixFor(dl.op) : " ",
          text: chunk,
          displayText: chunk,
          spans:
            spans.length > 0
              ? spans
              : [{ kind: "plain" as const, text: chunk }],
        });
        used += 1;
        offset = end;
      }
    }
  }

  if (change.truncated || used >= maxRows) {
    const totalTouched = Math.max(
      change.stats.newLines,
      change.stats.added + change.stats.removed,
    );
    const remaining = Math.max(0, totalTouched - used);
    const gap =
      remaining > 0
        ? `··· +${remaining} more · click for full ···`
        : `··· +${change.stats.added}/−${change.stats.removed} · click for full ···`;
    rows.push({
      tone: "gap",
      gutter: " ".repeat(width),
      prefix: "·",
      text: gap,
      displayText: gap,
      spans: [{ kind: "plain", text: gap }],
    });
  }

  if (rows.length === 0) {
    const empty = "(no line changes)";
    rows.push({
      tone: "context",
      gutter: " ".repeat(width),
      prefix: " ",
      text: empty,
      displayText: empty,
      spans: [{ kind: "plain", text: empty }],
    });
  }

  return rows;
}

export function presentAllFileChangePreviews(
  changes: readonly FileChange[],
  options: { maxLineChars?: number } = {},
): Array<{ change: FileChange; rows: PresentedDiffRow[] }> {
  return changes.map((change) => ({
    change,
    rows: presentFileChangePreview(change, options),
  }));
}

export function fileChangeExportText(change: FileChange): string {
  const head = `${change.kind} ${change.path}`;
  const body = formatUnifiedPreview(change);
  return `${head}\n${body}`;
}

export interface ModalPagerRow {
  readonly gutter: string;
  readonly body: string;
  readonly tone: DiffOp | "header";
  readonly spans: readonly SyntaxSpan[];
  readonly code: string;
}

export function buildModalPagerRows(
  change: FileChange,
  options: { maxHighlightLines?: number } = {},
): ModalPagerRow[] {
  const maxHl = options.maxHighlightLines ?? 5_000;
  const lines = buildModalLines(change);
  const width = Math.max(
    1,
    ...lines.map((l) =>
      typeof l.lineNo === "number"
        ? String(l.lineNo).length
        : typeof l.oldLineNo === "number"
          ? String(l.oldLineNo).length
          : 1,
    ),
  );
  const carry = emptyCarry();
  const rows: ModalPagerRow[] = [];

  rows.push({
    gutter: " ".repeat(width),
    body: `${change.kind} · ${change.path}`,
    tone: "header",
    spans: [{ kind: "plain", text: `${change.kind} · ${change.path}` }],
    code: `${change.kind} · ${change.path}`,
  });
  rows.push({
    gutter: " ".repeat(width),
    body: `+${change.stats.added} −${change.stats.removed} lines`,
    tone: "header",
    spans: [
      {
        kind: "plain",
        text: `+${change.stats.added} −${change.stats.removed} lines`,
      },
    ],
    code: `+${change.stats.added} −${change.stats.removed} lines`,
  });
  rows.push({
    gutter: " ".repeat(width),
    body: "",
    tone: "header",
    spans: [{ kind: "plain", text: "" }],
    code: "",
  });

  let idx = 0;
  for (const l of lines) {
    const num =
      l.op === "del"
        ? typeof l.oldLineNo === "number"
          ? String(l.oldLineNo).padStart(width, " ")
          : " ".repeat(width)
        : typeof l.lineNo === "number"
          ? String(l.lineNo).padStart(width, " ")
          : " ".repeat(width);
    const p = l.op === "add" ? "+" : l.op === "del" ? "−" : " ";
    const spans =
      idx < maxHl
        ? highlightLineForPath(l.text, change.path, carry)
        : ([{ kind: "plain" as const, text: l.text }] as SyntaxSpan[]);
    rows.push({
      gutter: num,
      body: `${p} ${l.text}`,
      tone: l.op,
      spans,
      code: l.text,
    });
    idx += 1;
  }
  return rows;
}

export function formatModalPlainText(change: FileChange): string {
  const rows = buildModalPagerRows(change);
  return rows
    .map((r) => {
      if (r.tone === "header") {
        return r.body ? `${r.gutter} │ ${r.body}` : `${r.gutter} │`;
      }
      return `${r.gutter} │ ${r.body}`;
    })
    .join("\n");
}

export type { ModalDiffLine, SyntaxSpan, LangId };

export function relativeDisplayPath(absPath: string): string {
  const roots = [getActiveProjectRoot(), safeCwd()].filter(
    (r): r is string => Boolean(r),
  );
  for (const root of roots) {
    try {
      const rel = relative(root, absPath);
      if (rel && !rel.startsWith("..") && !rel.startsWith("/")) {
        return rel.split("\\").join("/");
      }
    } catch {
    }
  }
  return absPath;
}

export function collapsedFileChangeLabel(change: FileChange): string {
  return `file  ${relativeDisplayPath(change.path)}`;
}

export function collapsedFileChangesLabel(changes: readonly FileChange[]): string {
  if (changes.length === 0) return "files";
  if (changes.length === 1) return collapsedFileChangeLabel(changes[0]!);
  const first = relativeDisplayPath(changes[0]!.path);
  return `files  ${changes.length}  ·  ${first}…`;
}
