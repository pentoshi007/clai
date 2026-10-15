import { describe, expect, it } from "vitest";
import { collapseOutputLines, presentOutput } from "../../../src/ui-core/rendering/tool-presenter.js";
import { presentBatchSection } from "../../../src/ui-core/rendering/batch-sections.js";

const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
const output = lines.join("\n");

describe("opt-in first-three output previews", () => {
  it("keeps the first three lines without a gap or sampled tail", () => {
    expect(presentOutput(output, undefined, false, "shell.exec", "first-three")).toEqual({
      lines: lines.slice(0, 3), hiddenAboveCount: 7, truncatedNotice: undefined,
    });
    expect(presentOutput(output, undefined, false).lines).toEqual([
      "line 1", "… 7 more lines", "line 9", "line 10",
    ]);
  });

  it.each([0, 1, 2, 3])("preserves all %i short output lines", count => {
    const body = lines.slice(0, count);
    expect(presentOutput(body.join("\n"), undefined, false, "", "first-three").lines).toEqual(body);
  });

  it("does not substitute sampled tail lines after a long first line", () => {
    const body = [`first ${"x".repeat(20_000)}`, "second", "third", "last"].join("\n");
    const preview = presentOutput(body, undefined, false, "shell.exec", "first-three");
    expect(preview.lines).toEqual(body.split("\n").slice(0, 3));
    expect(preview.hiddenAboveCount).toBe(1);
  });

  it("preserves terminal repetition and leaves frame metadata accessible on expansion", () => {
    const body = "[terminal.read] state=running transport=pty\n[terminal.output cursor=0 nextCursor=30]\nPassword: \nok\nok\n  value\nmsf6 > \n[/terminal.output]";
    const collapsed = presentOutput(body, undefined, false, "terminal.read", "first-three");
    expect(collapsed.lines).toEqual(["Password: ", "ok", "ok"]);
    expect(collapsed.hiddenAboveCount).toBe(4);
    const expanded = presentOutput(body, undefined, true, "terminal.read", "first-three");
    expect(expanded.lines).toContain("  value");
    expect(expanded.lines).toContain("msf6 > ");
    expect(expanded.lines).toContain("state=running transport=pty");
    expect(expanded.lines).toContain("cursor=0 nextCursor=30");
  });

  it("keeps full expansion and the existing overflow safety limit", () => {
    expect(presentOutput(output, undefined, true, "", "first-three").lines).toEqual(lines);
    const large = Array.from({ length: 4_100 }, (_, index) => `row ${index}`).join("\n");
    const expanded = presentOutput(large, undefined, true, "", "first-three");
    expect(expanded.lines).toHaveLength(7);
    expect(expanded.lines.join("\n")).toContain("open pager");
  });

  it("retains an explicit notice when the spool has already dropped its original head", () => {
    const state = { tail: output, totalBytes: 50_000, droppedBytes: 30_000, truncated: true };
    const preview = presentOutput(output, state, false, "", "first-three");
    expect(preview.lines).toEqual(lines.slice(0, 3));
    expect(preview.truncatedNotice).toContain("full output saved to disk");
  });

  it("supports styled markdown lines without a tail or synthetic gap", () => {
    const styled = lines.map(text => ({ text }));
    const result = collapseOutputLines(styled, count => ({ text: `gap ${count}` }), styled.length, "first-three");
    expect(result).toEqual({ lines: styled.slice(0, 3), hiddenAboveCount: 7 });
  });

  it("scopes nested batch previews while preserving status and full bodies", () => {
    const section = { index: 1, name: "shell.exec", ok: false, status: "fail" as const, exitCode: 2, body: output };
    const preview = presentBatchSection(section, false, 80, "first-three");
    expect(preview.lines).toEqual(lines.slice(0, 3));
    expect(preview.hiddenAboveCount).toBe(7);
    expect(preview.statusLabel).toBe("failed (exit 2)");
    expect(presentBatchSection(section, true, 80, "first-three").lines).toEqual(lines);
    expect(presentBatchSection(section, false).lines).toHaveLength(4);
    expect(section.body).toBe(output);
  });
});
