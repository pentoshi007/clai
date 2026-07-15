import { describe, expect, it } from "vitest";
import { asToolCallId } from "../../../src/app/events/app-event.js";
import type { ToolItem } from "../../../src/tui-v2/state/transcript-types.js";
import {
  cleanToolOutputLines,
  presentOutput,
  presentTool,
} from "../../../src/tui-v2/rendering/tool-presenter.js";

function toolItem(overrides: Partial<ToolItem> = {}): ToolItem {
  return {
    id: "c1",
    sequence: 1,
    turnId: undefined,
    timestamp: 0,
    kind: "tool",
    toolCallId: asToolCallId("c1"),
    name: "shell.exec",
    argsDisplay: "ls -la",
    status: "running",
    exitCode: undefined,
    summary: undefined,
    artifactPath: undefined,
    reason: undefined,
    outputBytes: 0,
    ...overrides,
  };
}

describe("presentTool (CHAT-004)", () => {
  it("shows a running glyph/label with command args", () => {
    const p = presentTool(toolItem());
    expect(p.glyph).toBe("●");
    expect(p.statusLabel).toBe("running");
    expect(p.name).toBe("shell.exec");
    expect(p.argsLabel).toBe("command");
    expect(p.argsDisplay).toBe("ls -la");
    expect(p.detail).toBeUndefined();
  });

  it("does not dump model context summary as detail on success", () => {
    const p = presentTool(
      toolItem({
        status: "ok",
        exitCode: 0,
        summary: "49.47.135.245\nFull output saved to: /tmp/x.txt",
      }),
    );
    expect(p.statusLabel).toBe("done (exit 0)");
    expect(p.detail).toBeUndefined();
  });

  it("shows the block reason instead of a summary when blocked", () => {
    const p = presentTool(
      toolItem({ status: "blocked", reason: "unsafe command", summary: "ignored" }),
    );
    expect(p.statusLabel).toBe("blocked");
    expect(p.detail).toBe("unsafe command");
  });

  it("falls back to the tool name alone with no args", () => {
    const p = presentTool(toolItem({ argsDisplay: "" }));
    expect(p.name).toBe("shell.exec");
    expect(p.argsDisplay).toBeUndefined();
  });

  it("labels non-shell args as input", () => {
    const p = presentTool(toolItem({ name: "fs.read", argsDisplay: "a.ts" }));
    expect(p.argsLabel).toBe("input");
  });
});

describe("cleanToolOutputLines", () => {
  it("strips classic stdout status/artifact chatter and consecutive dupes", () => {
    const raw = [
      "49.47.135.245",
      "49.47.135.245",
      "ok",
      "full output saved to /tmp/x.txt",
      "Full output saved to: /tmp/x.txt",
      "artifact: /tmp/x.txt",
      "49.47.135.245",
    ].join("\n");
    expect(cleanToolOutputLines(raw)).toEqual(["49.47.135.245"]);
  });
});

describe("presentOutput (CHAT-005, PERF-003)", () => {
  const tenLines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");

  it("shows a head+tail preview when collapsed, with a mid-body gap notice", () => {
    const p = presentOutput(tenLines, undefined, false);
    // Compact card: head + gap + tail, so the end of the output (often the
    // actual result) stays visible without opening the pager.
    expect(p.lines[0]).toBe("line 1");
    expect(p.lines[1]).toBe("line 2");
    expect(p.lines[2]).toBe("line 3");
    expect(p.lines[3]).toBe("line 4");
    expect(p.lines[4]).toBe("··· 2 lines more ···");
    expect(p.lines[5]).toBe("line 7");
    expect(p.lines[8]).toBe("line 10");
    expect(p.lines).toHaveLength(9);
    expect(p.hiddenAboveCount).toBe(2);
    expect(p.truncatedNotice).toBeUndefined();
  });

  it("collapses markdown links to their titles for the card preview", () => {
    const p = presentOutput(
      "[Liz Truss](https://en.wikipedia.org/wiki/Liz_Truss)\nplain",
      undefined,
      true,
    );
    expect(p.lines).toEqual(["Liz Truss", "plain"]);
  });

  it("shows every line when expanded (Ctrl+O full in-place)", () => {
    const p = presentOutput(tenLines, undefined, true);
    expect(p.lines).toHaveLength(10);
    expect(p.lines[0]).toBe("line 1");
    expect(p.lines[9]).toBe("line 10");
    expect(p.hiddenAboveCount).toBe(0);
  });

  it("shows a larger expanded body without the collapsed head/tail gap", () => {
    const many = Array.from({ length: 80 }, (_, i) => `row ${i + 1}`).join("\n");
    const p = presentOutput(many, undefined, true);
    expect(p.lines).toHaveLength(80);
    expect(p.lines.some((l) => l.startsWith("···"))).toBe(false);
    expect(p.hiddenAboveCount).toBe(0);
  });

  it("surfaces a truncation notice without silently dropping the notice itself", () => {
    const p = presentOutput(
      "tail only",
      { tail: "tail only", totalBytes: 50_000, droppedBytes: 30_000, truncated: true },
      true,
    );
    expect(p.truncatedNotice).toMatch(/truncated/);
    expect(p.truncatedNotice).toContain("29.3KB");
  });

  it("handles empty output without crashing", () => {
    const p = presentOutput("", undefined, false);
    expect(p.lines).toEqual([]);
    expect(p.hiddenAboveCount).toBe(0);
  });

  it("does not show ok/failed status lines in the body", () => {
    const p = presentOutput("hello\nok\nfailed\n", undefined, true);
    expect(p.lines).toEqual(["hello"]);
  });
});
