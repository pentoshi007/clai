
import { basename } from "node:path";
import { DIFF_MAX_LINES, DeletedSegment, DiffHunk, DiffOp, PREVIEW_CONTEXT, PREVIEW_MAX_DIFF_LINES, capPreviewHunks, collectAddedNewLines, collectDeletedAt, computeLineOps, countOps, groupHunks, wholeFileReplace } from "./diff/line-ops.js";
export { DIFF_MAX_LINES, PREVIEW_CONTEXT, PREVIEW_MAX_DIFF_LINES, capPreviewHunks, computeLineOps, groupHunks };
export type { DeletedSegment, DiffHunk, DiffLine, DiffOp } from "./diff/line-ops.js";

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

export interface FileChange {
  readonly path: string;
  readonly basename: string;
  readonly kind: FileChangeKind;
  readonly stats: FileChangeStats;
  readonly previewHunks: readonly DiffHunk[];
  readonly afterText?: string | undefined;
  readonly addedNewLines: readonly number[];
  readonly deletedAt: readonly DeletedSegment[];
  readonly snapshotPath?: string | undefined;
  readonly binary?: boolean | undefined;
  readonly truncated?: boolean | undefined;
}

export const DIFF_MAX_BYTES = 1_000_000;
export const INLINE_AFTER_MAX_BYTES = 48_000;

export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (text.endsWith("\n") || text.endsWith("\r\n")) {
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  }
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

export function looksBinary(text: string): boolean {
  const sample = text.slice(0, 8_192);
  return sample.includes("\0");
}

export interface BuildFileChangeOptions {
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly kind: FileChangeKind;
  readonly context?: number | undefined;
  readonly previewMaxLines?: number | undefined;
  readonly snapshotPath?: string | undefined;
}

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

export interface ModalDiffLine {
  readonly lineNo: number | undefined;
  readonly text: string;
  readonly op: DiffOp;
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

  if (afterLines.length === 0 && change.deletedAt.length > 0) {
  } else if (afterLines.length === 0 && change.kind === "delete" && change.stats.removed > 0) {
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
