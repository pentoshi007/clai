import { describe, expect, it } from "vitest";
import {
  clampArgsDisplay,
  presentTool,
} from "../../../src/ui-core/rendering/tool-presenter.js";
import { scrollbarSegments } from "../../../src/tui-v2/components/transcript/transcript-scrollbar.js";
import type { ToolItem } from "../../../src/ui-core/state/transcript-types.js";

/**
 * A heredoc (`cat > main.py << 'EOF' … EOF`) puts a whole source file into the
 * command string. Rendered verbatim it made one tool card hundreds of rows
 * tall, which overflowed the card border and squeezed the card's single-row
 * chrome (OUTPUT / SAVED / footer hint) into overlapping rows — the reported
 * "everything overflowing from their boxes" corruption.
 */
describe("oversized tool args never blow the card layout", () => {
  const heredoc = [
    "cat > /Users/x/main.py << 'EOF'",
    ...Array.from({ length: 240 }, (_, i) => `line_${i} = ${i}`),
    "EOF",
  ].join("\n");

  it("clamps a multi-hundred-line command to a bounded preview", () => {
    const clamped = clampArgsDisplay(heredoc);
    const lines = clamped!.split("\n");
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines[0]).toContain("cat >");
    expect(lines.at(-1)).toMatch(/\+\d+ more lines · click for full/);
  });

  it("passes an extremely long single line through for the card to wrap", () => {
    const clamped = clampArgsDisplay("x".repeat(5_000))!;
    expect(clamped.split("\n")).toHaveLength(1);
    expect(clamped).toHaveLength(5_000);
  });

  it("leaves a normal command untouched", () => {
    expect(clampArgsDisplay("npm run build")).toBe("npm run build");
    expect(clampArgsDisplay(undefined)).toBeUndefined();
  });

  it("presents shell.exec heredoc commands already bounded", () => {
    const item = {
      kind: "tool",
      id: "t1",
      name: "shell.exec",
      argsDisplay: heredoc,
      status: "done",
      outputBytes: 0,
    } as unknown as ToolItem;

    const presented = presentTool(item);
    expect(presented.argsDisplay!.split("\n").length).toBeLessThanOrEqual(4);
  });
});

describe("scrollbar segments do not overlap", () => {
  it("splits the track into above/thumb/below covering the height exactly once", () => {
    const segments = scrollbarSegments({ top: 3, size: 4 }, 10);
    expect(segments).toEqual({ above: 3, thumb: 4, below: 3 });
    expect(segments.above + segments.thumb + segments.below).toBe(10);
  });

  it("never exceeds the track height", () => {
    const segments = scrollbarSegments({ top: 8, size: 9 }, 10);
    expect(segments.thumb).toBe(2);
    expect(segments.above + segments.thumb + segments.below).toBe(10);
  });
});
