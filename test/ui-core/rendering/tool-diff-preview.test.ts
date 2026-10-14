import { describe, expect, it } from "vitest";
import { buildFileChange, type FileChange } from "../../../src/tools/file-diff.js";
import { buildModalPagerRows, presentFileChangePreview } from "../../../src/ui-core/rendering/file-diff-view.js";
import {
  COLLAPSED_DIFF_BODY_ROWS,
  presentToolDiffPreviews,
  type ToolDiffPreview,
  type ToolDiffPreviewOptions,
} from "../../../src/ui-core/rendering/tool-diff-preview.js";

function change(lines: number, file = 0): FileChange {
  return buildFileChange({
    path: `/repo/file-${file}.ts`, before: "", kind: "create",
    after: Array.from({ length: lines }, (_, row) => `const ROW_${file}_${row} = ${row};`).join("\n"),
  });
}

function options(overrides: Partial<ToolDiffPreviewOptions> = {}): ToolDiffPreviewOptions {
  return {
    expanded: false, showPaths: false, headerRows: 0, maxFiles: 12,
    maxRowsPerFile: 40, maxLineChars: () => 120, tabWidth: 4, ...overrides,
  };
}

function bodyRows(preview: ToolDiffPreview, spec: ToolDiffPreviewOptions): number {
  return spec.headerRows + Number(preview.hiddenFiles > 0)
    + preview.files.reduce((total, file) => total + Number(spec.showPaths) + file.rows.length, 0);
}

describe("tool diff preview row budget", () => {
  it.each([8, 16, 32, 120])("bounds wrapped rows at a %i-character code width", (width) => {
    for (const headerRows of [0, 1]) {
      for (const lines of [0, 1, 18, 19, 20, 21, 60]) {
        const spec = options({ headerRows, maxLineChars: () => width });
        const preview = presentToolDiffPreviews([change(lines)], spec);
        expect(bodyRows(preview, spec)).toBeLessThanOrEqual(COLLAPSED_DIFF_BODY_ROWS);
        expect(preview.hiddenFiles).toBe(0);
      }
    }
  });

  it.each([0, 1])("preserves exact-fit diffs with %i reserved header rows", (headerRows) => {
    const spec = options({ headerRows });
    const file = change(COLLAPSED_DIFF_BODY_ROWS - headerRows);
    const preview = presentToolDiffPreviews([file], spec);
    expect(bodyRows(preview, spec)).toBe(COLLAPSED_DIFF_BODY_ROWS);
    expect(preview.files[0]!.rows).toEqual(presentFileChangePreview(file, { maxRows: 40, maxLineChars: 120, tabWidth: 4 }));
    expect(preview.files[0]!.rows.some((row) => row.tone === "gap")).toBe(false);
  });

  it("reserves the omission notice inside the single-file limit", () => {
    const spec = options();
    const preview = presentToolDiffPreviews([change(60)], spec);
    expect(bodyRows(preview, spec)).toBe(20);
    expect(preview.files[0]!.rows).toHaveLength(20);
    expect(preview.files[0]!.rows.at(-1)?.tone).toBe("gap");
  });

  it.each([0, 1, 8, 12, 15, 30])("bounds %i files collectively, including paths and the hidden-files notice", (count) => {
    const files = Array.from({ length: count }, (_, file) => change(30, file));
    const spec = options({ showPaths: true, maxRowsPerFile: 8 });
    const preview = presentToolDiffPreviews(files, spec);
    expect(bodyRows(preview, spec)).toBeLessThanOrEqual(20);
    expect(preview.hiddenFiles).toBe(count - preview.files.length);
    if (count > 2) expect(preview.hiddenFiles).toBeGreaterThan(0);
    for (const file of preview.files) expect(files).toContain(file.change);
  });

  it("handles a final one-row budget without exceeding the limit", () => {
    const files = Array.from({ length: 21 }, (_, file) => change(1, file));
    const spec = options();
    const preview = presentToolDiffPreviews(files, { ...spec, maxFiles: files.length });
    expect(preview.files).toHaveLength(19);
    expect(preview.hiddenFiles).toBe(2);
    expect(bodyRows(preview, spec)).toBe(20);
  });

  it("bounds binary and empty files without adding a fake gap", () => {
    const files = Array.from({ length: 15 }, (_, file) => ({ ...change(0, file), binary: file % 2 === 0 }));
    const spec = options({ showPaths: true, maxRowsPerFile: 8 });
    const preview = presentToolDiffPreviews(files, spec);
    expect(bodyRows(preview, spec)).toBeLessThanOrEqual(20);
    expect(preview.files.every((file) => file.rows.length === 1 && file.rows[0]!.tone !== "gap")).toBe(true);
    expect(preview.hiddenFiles).toBe(files.length - preview.files.length);
  });

  it.each([false, true])("preserves the original expanded single/multi-file budgets (multi=%s)", (multi) => {
    const files = Array.from({ length: multi ? 15 : 1 }, (_, file) => change(60, file));
    const spec = options({ expanded: true, showPaths: multi, headerRows: Number(!multi), maxRowsPerFile: multi ? 8 : 40 });
    const preview = presentToolDiffPreviews(files, spec);
    expect(bodyRows(preview, spec)).toBeGreaterThan(20);
    expect(preview.files).toHaveLength(Math.min(12, files.length));
    expect(preview.hiddenFiles).toBe(Math.max(0, files.length - 12));
    for (const file of preview.files) {
      expect(file.rows).toEqual(presentFileChangePreview(file.change, { maxRows: spec.maxRowsPerFile, maxLineChars: 120, tabWidth: 4 }));
    }
  });

  it("does not mutate stored changes, full pager rows, or default presenter behavior", () => {
    const files = [change(60)];
    const stored = structuredClone(files);
    const pager = buildModalPagerRows(files[0]!);
    const original = presentFileChangePreview(files[0]!);
    presentToolDiffPreviews(files, options());
    expect(files).toEqual(stored);
    expect(buildModalPagerRows(files[0]!)).toEqual(pager);
    expect(pager.map((row) => row.body).join("\n")).toContain("ROW_0_59");
    expect(presentFileChangePreview(files[0]!)).toEqual(original);
  });
});
