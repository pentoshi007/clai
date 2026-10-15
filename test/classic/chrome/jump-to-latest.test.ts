import { describe, expect, it } from "vitest";
import { composerDirectoryRow, composerDirectoryView } from "../../../src/classic/chrome/directory-row.js";
import { jumpToLatestLabel } from "../../../src/ui-core/rendering/jump-to-latest.js";
import { createInkTheme } from "../../../src/classic/render/ink-theme.js";
import { displayWidth, stripAnsi } from "../../../src/classic/render/measure.js";

const ink = createInkTheme({ themeHint: "dark", colorMode: "truecolor", unicode: true });
const base = { ink, cwd: "/repo/目录/clai", branch: "main", hasActivePlan: true, planVisible: false, queued: 2, queueVisible: true };

describe("jump-to-latest chrome", () => {
  it("leaves the directory and hints unchanged at the latest position", () => {
    const input = { ...base, columns: 120, showJumpToLatest: false };
    expect(composerDirectoryView(input)).toEqual({ line: composerDirectoryRow(input), jump: undefined });
  });

  it.each([1, 2, 3, 12, 24, 28, 40, 80, 120, 200])("keeps the rendered target inside %i columns", columns => {
    const view = composerDirectoryView({ ...base, columns, showJumpToLatest: true });
    expect(displayWidth(view.line)).toBeLessThanOrEqual(columns);
    if (columns < 3) return;
    expect(view.jump).toBeDefined();
    const target = view.jump!;
    const text = stripAnsi(view.line);
    const start = text.lastIndexOf("[");
    expect(displayWidth(text.slice(0, start))).toBe(target.left);
    expect(text.slice(start).trimEnd()).toMatch(/^\[.*↓.*\]$/);
    expect(target.left + target.width).toBeLessThanOrEqual(columns);
  });

  it("places the control to the right of task and queue hints", () => {
    const text = stripAnsi(composerDirectoryView({ ...base, columns: 120, showJumpToLatest: true }).line);
    expect(text.indexOf("Tasks active")).toBeLessThan(text.indexOf("2 queued"));
    expect(text.indexOf("2 queued")).toBeLessThan(text.indexOf("Jump to latest"));
    expect(text).toContain("Ctrl+Z");
  });

  it("keeps ASCII and narrow labels portable", () => {
    expect(jumpToLatestLabel(20, false)).toBe("[Jump to latest]");
    expect(jumpToLatestLabel(10, false)).toBe("[Latest]");
    expect(jumpToLatestLabel(3, false)).toBe("[v]");
    expect(jumpToLatestLabel(2, true)).toBe("");
  });
});
