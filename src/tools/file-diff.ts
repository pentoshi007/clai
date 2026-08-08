/**
 * Pure line-diff engine for file mutation tools (fs.edit / write / append / …).
 * Produces Cursor/Claude-style hunks with configurable context and size caps.
 */

import { basename } from "node:path";

export type DiffOp = "context" | "add" | "del";

export interface DiffLine {
  readonly op: DiffOp;
  readonly text: string;
  /** 1-based line in the old file; undefined for pure adds */
  readonly oldLine?: number | undefined;
  /** 1-based line in the new file; undefined for pure dels */
  readonly newLine?: number | undefined;
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: readonly DiffLine[];
}

export type FileChangeKind =
  | "create"
  | "edit"
  | "overwrite"
  | "append"
  | "delete";

export interface FileChangeStats {
  readonly oldLines: number;
  readonly newLines: number;
  readonly added: number;
  readonly removed: number;
}

export interface DeletedSegment {
  /** 1-based line in the new file after which these deletions sit (0 = before first) */
  readonly atNewLine: number;
  readonly oldStart: number;
  readonly lines: readonly string[];
}

export interface FileChange {
  readonly path: string;
  readonly basename: string;
  readonly kind: FileChangeKind;
  readonly stats: FileChangeStats;
  /** Chat preview hunks (context=1, capped). */
  readonly previewHunks: readonly DiffHunk[];
  /**
   * Full after-content for the modal. Omitted when too large (use snapshotPath)
   * or for deletes (after is empty).
   */
  readonly afterText?: string | undefined;
  /** New-file line numbers that are pure additions. */
  readonly addedNewLines: readonly number[];
  /** Deleted segments for full-file modal rendering. */
  readonly deletedAt: readonly DeletedSegment[];
  /** Optional on-disk JSON snapshot for large files. */
  readonly snapshotPath?: string | undefined;
  /** True when content was treated as binary / non-diffable. */
  readonly binary?: boolean | undefined;
  /** True when diff was collapsed due to size caps. */
  readonly truncated?: boolean | undefined;
}

/** Max lines on either side before falling back to whole-file replace. */
export const DIFF_MAX_LINES = 20_000;
/** Max UTF-8 bytes on either side for full LCS. */
export const DIFF_MAX_BYTES = 1_000_000;
/**
 * Max afterText kept inline on FileChange (else snapshot only).
 * Kept modest so transcript tool cards from writeMany scaffolds do not pin
 * multi‑MB file bodies in the TUI process for the whole session.
 */
export const INLINE_AFTER_MAX_BYTES = 48_000;
/** Max diff body lines in chat preview. */
export const PREVIEW_MAX_DIFF_LINES = 40;
/** Context lines around each change for chat. */
export const PREVIEW_CONTEXT = 1;

export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  // Trailing newline produces a final empty entry — keep content lines only
  // when the file ends with newline (standard diff behavior keeps the empty
  // last element only if there is content after the last newline).
  if (text.endsWith("\n") || text.endsWith("\r\n")) {
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  }
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

export function looksBinary(text: string): boolean {
  // NUL in the first 8KB is a strong binary signal.
  const sample = text.slice(0, 8_192);
  return sample.includes("\0");
}

/**
 * Myers O(ND) line diff → list of ops over the full file (no hunk grouping).
 * Falls back to whole-file replace when sizes exceed caps.
 */
export function computeLineOps(
  oldLines: readonly string[],
  newLines: readonly string[],
): DiffLine[] {
  const n = oldLines.length;
  const m = newLines.length;

  if (n === 0 && m === 0) return [];
  if (n === 0) {
    return newLines.map((text, i) => ({
      op: "add" as const,
      text,
      newLine: i + 1,
    }));
  }
  if (m === 0) {
    return oldLines.map((text, i) => ({
      op: "del" as const,
      text,
      oldLine: i + 1,
    }));
  }

  let prefix = 0;
  while (prefix < n && prefix < m && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < n - prefix &&
    suffix < m - prefix &&
    oldLines[n - 1 - suffix] === newLines[m - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldMiddle = oldLines.slice(prefix, n - suffix);
  const newMiddle = newLines.slice(prefix, m - suffix);
  const middleN = oldMiddle.length;
  const middleM = newMiddle.length;

  const prefixOps: DiffLine[] = [];
  for (let i = 0; i < prefix; i += 1) {
    prefixOps.push({
      op: "context",
      text: oldLines[i]!,
      oldLine: i + 1,
      newLine: i + 1,
    });
  }

  const suffixOps: DiffLine[] = [];
  for (let i = 0; i < suffix; i += 1) {
    suffixOps.push({
      op: "context",
      text: oldLines[n - suffix + i]!,
      oldLine: n - suffix + i + 1,
      newLine: m - suffix + i + 1,
    });
  }

  if (middleN > DIFF_MAX_LINES || middleM > DIFF_MAX_LINES || middleN * middleM > 4_000_000) {
    const middleReplace = wholeFileReplace(oldMiddle, newMiddle);
    const shiftedMiddle = middleReplace.map((op) => {
      if (op.op === "add") return { ...op, newLine: op.newLine! + prefix };
      if (op.op === "del") return { ...op, oldLine: op.oldLine! + prefix };
      return { ...op, oldLine: op.oldLine! + prefix, newLine: op.newLine! + prefix };
    });
    return [...prefixOps, ...shiftedMiddle, ...suffixOps];
  }

  const dp: Uint32Array[] = new Array(middleN + 1);
  for (let i = 0; i <= middleN; i += 1) dp[i] = new Uint32Array(middleM + 1);
  for (let i = 1; i <= middleN; i += 1) {
    const oi = oldMiddle[i - 1]!;
    const row = dp[i]!;
    const prev = dp[i - 1]!;
    for (let j = 1; j <= middleM; j += 1) {
      if (oi === newMiddle[j - 1]) row[j] = prev[j - 1]! + 1;
      else row[j] = Math.max(prev[j]!, row[j - 1]!);
    }
  }

  const rev: DiffLine[] = [];
  let i = middleN;
  let j = middleM;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldMiddle[i - 1] === newMiddle[j - 1]) {
      rev.push({
        op: "context",
        text: oldMiddle[i - 1]!,
        oldLine: i + prefix,
        newLine: j + prefix,
      });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      rev.push({ op: "add", text: newMiddle[j - 1]!, newLine: j + prefix });
      j -= 1;
    } else {
      rev.push({ op: "del", text: oldMiddle[i - 1]!, oldLine: i + prefix });
      i -= 1;
    }
  }
  rev.reverse();

  return [...prefixOps, ...rev, ...suffixOps];
}

function wholeFileReplace(
  oldLines: readonly string[],
  newLines: readonly string[],
): DiffLine[] {
  const out: DiffLine[] = [];
  for (let i = 0; i < oldLines.length; i += 1) {
    out.push({ op: "del", text: oldLines[i]!, oldLine: i + 1 });
  }
  for (let i = 0; i < newLines.length; i += 1) {
    out.push({ op: "add", text: newLines[i]!, newLine: i + 1 });
  }
  return out;
}

/**
 * Group full-file ops into unified hunks with `context` lines of surrounding
 * unchanged content. Adjacent change regions within `context*2` merge.
 */
export function groupHunks(
  ops: readonly DiffLine[],
  context = PREVIEW_CONTEXT,
): DiffHunk[] {
  if (ops.length === 0) return [];

  // Mark change indices
  const isChange = ops.map((o) => o.op !== "context");
  if (!isChange.some(Boolean)) return [];

  // Expand change islands by context
  const include = new Array<boolean>(ops.length).fill(false);
  for (let i = 0; i < ops.length; i += 1) {
    if (!isChange[i]) continue;
    const from = Math.max(0, i - context);
    const to = Math.min(ops.length - 1, i + context);
    for (let k = from; k <= to; k += 1) include[k] = true;
  }

  const hunks: DiffHunk[] = [];
  let i = 0;
  while (i < ops.length) {
    if (!include[i]) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < ops.length && include[i]) i += 1;
    const slice = ops.slice(start, i);
    const first = slice[0]!;
    hunks.push({
      oldStart: first.oldLine ?? first.newLine ?? 1,
      newStart: first.newLine ?? first.oldLine ?? 1,
      lines: slice,
    });
  }
  return hunks;
}

/** Cap total preview lines across hunks; drop tail hunks with a sentinel. */
export function capPreviewHunks(
  hunks: readonly DiffHunk[],
  maxLines = PREVIEW_MAX_DIFF_LINES,
): { hunks: DiffHunk[]; truncated: boolean; omittedLines: number } {
  let used = 0;
  const out: DiffHunk[] = [];
  let omitted = 0;
  for (const h of hunks) {
    if (used >= maxLines) {
      omitted += h.lines.length;
      continue;
    }
    const room = maxLines - used;
    if (h.lines.length <= room) {
      out.push(h);
      used += h.lines.length;
    } else {
      out.push({
        oldStart: h.oldStart,
        newStart: h.newStart,
        lines: h.lines.slice(0, room),
      });
      used += room;
      omitted += h.lines.length - room;
    }
  }
  return { hunks: out, truncated: omitted > 0, omittedLines: omitted };
}

function countOps(ops: readonly DiffLine[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.op === "add") added += 1;
    else if (o.op === "del") removed += 1;
  }
  return { added, removed };
}

function collectAddedNewLines(ops: readonly DiffLine[]): number[] {
  const out: number[] = [];
  for (const o of ops) {
    if (o.op === "add" && typeof o.newLine === "number") out.push(o.newLine);
  }
  return out;
}

function collectDeletedAt(ops: readonly DiffLine[]): DeletedSegment[] {
  const segments: DeletedSegment[] = [];
  let i = 0;
  // Track the last seen new-line number so deletions attach after it.
  let lastNew = 0;
  while (i < ops.length) {
    const op = ops[i]!;
    if (op.op === "context" || op.op === "add") {
      if (typeof op.newLine === "number") lastNew = op.newLine;
      i += 1;
      continue;
    }
    // del run
    const lines: string[] = [];
    const oldStart = op.oldLine ?? 1;
    while (i < ops.length && ops[i]!.op === "del") {
      lines.push(ops[i]!.text);
      i += 1;
    }
    segments.push({ atNewLine: lastNew, oldStart, lines });
  }
  return segments;
}

export interface BuildFileChangeOptions {
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly kind: FileChangeKind;
  readonly context?: number | undefined;
  readonly previewMaxLines?: number | undefined;
  /** When set, afterText is omitted from the in-memory object. */
  readonly snapshotPath?: string | undefined;
}

/**
 * Build a UI-ready FileChange from before/after text.
 */
export function buildFileChange(opts: BuildFileChangeOptions): FileChange {
  const path = opts.path;
  const base = basename(path);
  const before = opts.before;
  const after = opts.after;

  if (looksBinary(before) || looksBinary(after)) {
    const oldLines = before.length === 0 ? 0 : 1;
    const newLines = after.length === 0 ? 0 : 1;
    return {
      path,
      basename: base,
      kind: opts.kind,
      stats: {
        oldLines,
        newLines,
        added: after.length > 0 ? 1 : 0,
        removed: before.length > 0 ? 1 : 0,
      },
      previewHunks: [],
      binary: true,
      ...(after.length <= INLINE_AFTER_MAX_BYTES && !opts.snapshotPath
        ? { afterText: after }
        : {}),
      ...(opts.snapshotPath ? { snapshotPath: opts.snapshotPath } : {}),
      addedNewLines: [],
      deletedAt: [],
    };
  }

  const beforeBytes = Buffer.byteLength(before, "utf8");
  const afterBytes = Buffer.byteLength(after, "utf8");
  const oversized =
    beforeBytes > DIFF_MAX_BYTES ||
    afterBytes > DIFF_MAX_BYTES ||
    splitLines(before).length > DIFF_MAX_LINES ||
    splitLines(after).length > DIFF_MAX_LINES;

  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const ops = oversized
    ? wholeFileReplace(oldLines, newLines)
    : computeLineOps(oldLines, newLines);
  const { added, removed } = countOps(ops);
  const rawHunks = groupHunks(ops, opts.context ?? PREVIEW_CONTEXT);
  const capped = capPreviewHunks(
    rawHunks,
    opts.previewMaxLines ?? PREVIEW_MAX_DIFF_LINES,
  );

  const keepInline =
    !opts.snapshotPath && afterBytes <= INLINE_AFTER_MAX_BYTES;

  // Full line-number maps / deleted bodies are only needed for the full-file
  // modal. Cap them so chat cards from large creates/overwrites cannot pin
  // tens of thousands of line strings in the process heap.
  const MAX_ADDED_LINE_MAP = 2_000;
  const MAX_DELETED_BODY_CHARS = 32_000;
  let addedNewLines = collectAddedNewLines(ops);
  if (addedNewLines.length > MAX_ADDED_LINE_MAP) {
    addedNewLines = addedNewLines.slice(0, MAX_ADDED_LINE_MAP);
  }
  let deletedAt = collectDeletedAt(ops);
  let deletedChars = 0;
  for (const seg of deletedAt) {
    for (const line of seg.lines) deletedChars += line.length + 1;
  }
  if (deletedChars > MAX_DELETED_BODY_CHARS) {
    deletedAt = [];
  }

  return {
    path,
    basename: base,
    kind: opts.kind,
    stats: {
      oldLines: oldLines.length,
      newLines: newLines.length,
      added,
      removed,
    },
    previewHunks: capped.hunks,
    addedNewLines,
    deletedAt,
    truncated: capped.truncated || oversized || deletedChars > MAX_DELETED_BODY_CHARS,
    binary: false,
    ...(keepInline ? { afterText: after } : {}),
    ...(opts.snapshotPath ? { snapshotPath: opts.snapshotPath } : {}),
  };
}

/** Infer kind from before/after when the caller only knows the tool. */
export function inferChangeKind(
  before: string | undefined,
  after: string,
  toolHint?: "append" | "delete" | "edit" | "write",
): FileChangeKind {
  if (toolHint === "delete") return "delete";
  if (toolHint === "append") {
    return before === undefined || before.length === 0 ? "create" : "append";
  }
  if (before === undefined || before.length === 0) return "create";
  if (after.length === 0) return "delete";
  if (toolHint === "write" && before.length > 0) return "overwrite";
  return "edit";
}

/**
 * Render preview hunks as plain text (for spool / export / classic REPL).
 * Uses unified +/- prefixes; no ANSI.
 */
export function formatUnifiedPreview(
  change: FileChange,
  options: { maxLines?: number } = {},
): string {
  if (change.binary) {
    return `binary file · ${change.basename} (${change.stats.newLines ? "changed" : "removed"})`;
  }
  const lines: string[] = [];
  const max = options.maxLines ?? PREVIEW_MAX_DIFF_LINES;
  let used = 0;
  for (const hunk of change.previewHunks) {
    if (used >= max) break;
    lines.push(`@@ -${hunk.oldStart} +${hunk.newStart} @@`);
    used += 1;
    for (const dl of hunk.lines) {
      if (used >= max) break;
      const prefix = dl.op === "add" ? "+" : dl.op === "del" ? "-" : " ";
      lines.push(`${prefix}${dl.text}`);
      used += 1;
    }
  }
  if (change.truncated) {
    lines.push(
      `··· more changes truncated · +${change.stats.added}/-${change.stats.removed} total ···`,
    );
  }
  if (lines.length === 0) {
    return `(no line changes in ${change.basename})`;
  }
  return lines.join("\n");
}

/**
 * Full modal body lines: after-file order with deleted segments injected.
 * Each entry carries a display line number (new-file) and op for coloring.
 */
export interface ModalDiffLine {
  readonly lineNo: number | undefined;
  readonly text: string;
  readonly op: DiffOp;
  /** For dels, old line number when known */
  readonly oldLineNo?: number | undefined;
}

export function buildModalLines(change: FileChange): ModalDiffLine[] {
  if (change.binary) {
    return [
      {
        lineNo: undefined,
        text: `(binary file — ${change.path})`,
        op: "context",
      },
    ];
  }

  const after = change.afterText ?? "";
  const afterLines = splitLines(after);
  const addedSet = new Set(change.addedNewLines);
  const delByAt = new Map<number, DeletedSegment[]>();
  for (const seg of change.deletedAt) {
    const list = delByAt.get(seg.atNewLine) ?? [];
    list.push(seg);
    delByAt.set(seg.atNewLine, list);
  }

  const out: ModalDiffLine[] = [];

  // Deletions before first new line
  for (const seg of delByAt.get(0) ?? []) {
    seg.lines.forEach((text, idx) => {
      out.push({
        lineNo: undefined,
        text,
        op: "del",
        oldLineNo: seg.oldStart + idx,
      });
    });
  }

  for (let i = 0; i < afterLines.length; i += 1) {
    const newLine = i + 1;
    const text = afterLines[i]!;
    out.push({
      lineNo: newLine,
      text,
      op: addedSet.has(newLine) ? "add" : "context",
    });
    for (const seg of delByAt.get(newLine) ?? []) {
      seg.lines.forEach((dtext, idx) => {
        out.push({
          lineNo: undefined,
          text: dtext,
          op: "del",
          oldLineNo: seg.oldStart + idx,
        });
      });
    }
  }

  // Pure delete (empty after): show all deleted lines
  if (afterLines.length === 0 && change.deletedAt.length > 0) {
    // already handled via atNewLine 0; if empty deletedAt but kind delete, rebuild
  } else if (afterLines.length === 0 && change.kind === "delete" && change.stats.removed > 0) {
    // fallback: nothing in after, deletedAt may have been built from ops
  }

  if (out.length === 0 && change.kind === "delete") {
    return [
      {
        lineNo: undefined,
        text: `(deleted ${change.path})`,
        op: "del",
      },
    ];
  }

  return out;
}

/** Human verb for status titles. */
export function changeVerb(
  kind: FileChangeKind,
  status: "running" | "ok" | "failed",
): string {
  if (status === "failed") {
    switch (kind) {
      case "create":
        return "Create failed";
      case "delete":
        return "Delete failed";
      case "append":
        return "Append failed";
      case "overwrite":
        return "Write failed";
      default:
        return "Edit failed";
    }
  }
  if (status === "running") {
    switch (kind) {
      case "create":
        return "Creating";
      case "delete":
        return "Deleting";
      case "append":
        return "Appending";
      case "overwrite":
        return "Writing";
      default:
        return "Editing";
    }
  }
  // ok
  switch (kind) {
    case "create":
      return "Created";
    case "delete":
      return "Deleted";
    case "append":
      return "Appended";
    case "overwrite":
      return "Wrote";
    default:
      return "Edited";
  }
}

/** Map tool name + optional kind to a display title basename. */
export function fileToolTitle(
  toolName: string,
  status: "queued" | "running" | "ok" | "failed" | "blocked",
  pathOrDisplay: string,
  kind?: FileChangeKind | undefined,
): { title: string; pathLine: string | undefined } {
  const rawPath = pathOrDisplay.trim();
  const path = /^(?:edit|write|append|delete|replaceLines)$/i.test(rawPath)
    ? ""
    : rawPath;
  const base = path ? basename(path.split(/\s|,/)[0] ?? path) : "file";
  const fullPath = path && path.includes("/") ? path : undefined;

  if (toolName === "fs.writeMany") {
    // pathOrDisplay may be "3 file(s): a, b" from formatToolArgs, a count, or
    // (legacy) raw JSON — never dump JSON into the title.
    // Prefer structured fileChanges count from the caller when present;
    // do not claim "Wrote 6 files" from args alone when the write failed
    // or fileChanges is empty (ghost second card).
    const countMatch = /^(\d+)\s*file/i.exec(path);
    const count = countMatch ? Number(countMatch[1]) : 0;
    const label =
      count > 0
        ? `${count} file${count === 1 ? "" : "s"}`
        : path && !path.startsWith("{") && path.length < 80 && path !== "files"
          ? path
          : "files";
    if (status === "running" || status === "queued") {
      return { title: `Writing ${label}`, pathLine: undefined };
    }
    if (status === "failed" || status === "blocked") {
      return {
        title: count > 0 ? `Write failed · ${label}` : "Write failed",
        pathLine: undefined,
      };
    }
    // Success without a countable label → generic title (empty fileChanges).
    if (count === 0 && (path === "files" || !path)) {
      return { title: "Wrote files", pathLine: undefined };
    }
    return { title: `Wrote ${label}`, pathLine: undefined };
  }

  const inferred: FileChangeKind =
    kind ??
    (toolName === "fs.delete"
      ? "delete"
      : toolName === "fs.append"
        ? "append"
        : toolName === "fs.write"
          ? "overwrite"
          : "edit");

  const st =
    status === "running" || status === "queued"
      ? "running"
      : status === "failed" || status === "blocked"
        ? "failed"
        : "ok";
  const verb = changeVerb(inferred, st);
  if (!path) return { title: verb, pathLine: undefined };
  const sep = st === "failed" ? " · " : " ";
  return {
    title: `${verb}${sep}${base}`,
    pathLine: fullPath,
  };
}

export function isFileMutationTool(name: string): boolean {
  return (
    name === "fs.edit" ||
    name === "fs.write" ||
    name === "fs.writeMany" ||
    name === "fs.append" ||
    name === "fs.replaceLines" ||
    name === "fs.delete"
  );
}
