import { describe, expect, it } from "vitest";
import {
  defaultPagerMarkdownMode,
  isMarkdownPath,
  isPureAddFileChange,
  shouldDefaultFormattedView,
} from "../../../src/ui-core/rendering/pager-view-policy.js";
import type { FileChange } from "../../../src/tools/file-diff.js";

function change(
  partial: Partial<FileChange> & Pick<FileChange, "path" | "kind">,
): FileChange {
  return {
    basename: "x.md",
    stats: { oldLines: 0, newLines: 10, added: 10, removed: 0 },
    previewHunks: [],
    addedNewLines: [],
    deletedAt: [],
    afterText: "# Hello\n\nWorld\n",
    ...partial,
  };
}

describe("pager-view-policy", () => {
  it("detects markdown paths", () => {
    expect(isMarkdownPath("a/b/report.md")).toBe(true);
    expect(isMarkdownPath("README.markdown")).toBe(true);
    expect(isMarkdownPath("src/app.ts")).toBe(false);
  });

  it("treats create / green-only as pure-add", () => {
    expect(
      isPureAddFileChange(
        change({ kind: "create", stats: { oldLines: 0, newLines: 5, added: 5, removed: 0 } }),
      ),
    ).toBe(true);
    expect(
      isPureAddFileChange(
        change({
          kind: "edit",
          stats: { oldLines: 10, newLines: 12, added: 3, removed: 1 },
        }),
      ),
    ).toBe(false);
  });

  it("formats compacted / help / md reads; raw for all file mutations and shell", () => {
    expect(shouldDefaultFormattedView({ kind: "compacted" })).toBe(true);
    expect(shouldDefaultFormattedView({ kind: "help" })).toBe(true);
    // Pure-green .md create/append: raw green editor (not formatted doc).
    expect(
      shouldDefaultFormattedView({
        kind: "file-change",
        fileChange: change({ kind: "create", path: "/tmp/report.md" }),
      }),
    ).toBe(false);
    expect(
      shouldDefaultFormattedView({
        kind: "file-change",
        fileChange: change({
          kind: "append",
          path: "/tmp/report.md",
          stats: { oldLines: 20, newLines: 30, added: 10, removed: 0 },
        }),
      }),
    ).toBe(false);
    expect(
      shouldDefaultFormattedView({
        kind: "file-change",
        fileChange: change({
          kind: "edit",
          path: "/tmp/report.md",
          stats: { oldLines: 20, newLines: 22, added: 4, removed: 2 },
        }),
      }),
    ).toBe(false);
    expect(
      shouldDefaultFormattedView({
        kind: "tool",
        toolName: "fs.read",
        path: "/tmp/notes.md",
        body: "# hi",
      }),
    ).toBe(true);
    expect(
      shouldDefaultFormattedView({
        kind: "tool",
        toolName: "fs.append",
        path: "/tmp/notes.md",
        body: "# hi",
      }),
    ).toBe(false);
    expect(
      shouldDefaultFormattedView({
        kind: "tool",
        toolName: "shell.exec",
        body: "# not really md context",
      }),
    ).toBe(false);
    expect(
      defaultPagerMarkdownMode({ kind: "compacted" }),
    ).toBe("force");
    expect(
      defaultPagerMarkdownMode({
        kind: "tool",
        toolName: "http.fetch",
      }),
    ).toBe("plain");
    expect(
      defaultPagerMarkdownMode({
        kind: "file-change",
        fileChange: change({ kind: "append", path: "/tmp/notes.md" }),
      }),
    ).toBe("plain");
  });
});
