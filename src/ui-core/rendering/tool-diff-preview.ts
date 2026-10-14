import type { FileChange } from "../../tools/file-diff.js";
import { presentFileChangePreview, type PresentedDiffRow } from "./file-diff-view.js";

export const COLLAPSED_DIFF_BODY_ROWS = 20;

export interface ToolDiffPreviewOptions {
  readonly expanded: boolean;
  readonly showPaths: boolean;
  readonly headerRows: number;
  readonly maxFiles: number;
  readonly maxRowsPerFile: number;
  readonly maxLineChars: (change: FileChange) => number;
  readonly tabWidth: number;
}

export interface ToolFileDiffPreview {
  readonly change: FileChange;
  readonly rows: readonly PresentedDiffRow[];
}

export interface ToolDiffPreview {
  readonly files: readonly ToolFileDiffPreview[];
  readonly hiddenFiles: number;
}

function previewRows(change: FileChange, options: ToolDiffPreviewOptions, budget: number): PresentedDiffRow[] {
  const maxRows = options.expanded ? options.maxRowsPerFile : Math.min(options.maxRowsPerFile, budget + 1);
  const spec = { maxRows, maxLineChars: options.maxLineChars(change), tabWidth: options.tabWidth };
  const rows = presentFileChangePreview(change, spec);
  if (options.expanded || rows.length <= budget) return rows;
  return presentFileChangePreview(change, { ...spec, maxRows: budget - 1 });
}

export function presentToolDiffPreviews(
  changes: readonly FileChange[],
  options: ToolDiffPreviewOptions,
): ToolDiffPreview {
  let remaining = options.expanded ? Number.POSITIVE_INFINITY : COLLAPSED_DIFF_BODY_ROWS - options.headerRows;
  const files: ToolFileDiffPreview[] = [];
  const listed = changes.slice(0, options.maxFiles);
  const pathRows = Number(options.showPaths);
  for (const [index, change] of listed.entries()) {
    const noticeRows = Number(index < changes.length - 1);
    const budget = remaining - pathRows - noticeRows;
    if (budget < 1) break;
    const rows = previewRows(change, options, budget);
    files.push({ change, rows });
    remaining -= pathRows + rows.length;
  }
  return { files, hiddenFiles: changes.length - files.length };
}
