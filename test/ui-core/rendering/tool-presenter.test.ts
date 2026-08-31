import { describe, expect, it } from "vitest";
import { asToolCallId } from "../../../src/app/events/app-event.js";
import type { ToolItem } from "../../../src/ui-core/state/transcript-types.js";
import {
  cleanToolOutputLines,
  evidencePreviewLines,
  presentOutput,
  presentTool,
} from "../../../src/ui-core/rendering/tool-presenter.js";

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
    fileChanges: undefined,
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
    // Success badge stays short so it never overflows the card border.
    expect(p.statusLabel).toBe("done");
    expect(p.detail).toBeUndefined();
  });

  it("labels exit 127 as not found", () => {
    const p = presentTool(
      toolItem({ status: "failed", exitCode: 127, summary: "yarn missing" }),
    );
    expect(p.statusLabel).toBe("failed · 127 · not found");
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

  it("titles fs.edit with basename and hides JSON args", () => {
    const p = presentTool(
      toolItem({
        name: "fs.edit",
        argsDisplay: "/Users/me/project/src/App.css",
        status: "ok",
        fileChanges: [
          {
            path: "/Users/me/project/src/App.css",
            basename: "App.css",
            kind: "edit",
            stats: { oldLines: 3, newLines: 4, added: 2, removed: 1 },
            previewHunks: [
              {
                oldStart: 2,
                newStart: 2,
                lines: [
                  { op: "context", text: "keep", oldLine: 1, newLine: 1 },
                  { op: "del", text: "old", oldLine: 2 },
                  { op: "add", text: "new", newLine: 2 },
                ],
              },
            ],
            addedNewLines: [2],
            deletedAt: [{ atNewLine: 1, oldStart: 2, lines: ["old"] }],
            afterText: "keep\nnew\n",
          },
        ],
      }),
    );
    expect(p.name).toBe("Edited App.css");
    expect(p.argsDisplay).toBeUndefined();
    expect(p.isFileDiff).toBe(true);
    expect(p.pathLine).toContain("App.css");
  });

  it("titles fs.write from JSON argsDisplay when fileChanges is missing", () => {
    // History rows that lost structured diffs still must not show "Wrote write"
    // or dump the content JSON under the card.
    const p = presentTool(
      toolItem({
        name: "fs.write",
        status: "ok",
        argsDisplay: JSON.stringify({
          path: "/Users/me/todo-app/src/main.tsx",
          content: "import React from 'react'\n",
        }),
        fileChanges: undefined,
      }),
    );
    expect(p.name).toBe("Wrote main.tsx");
    expect(p.argsDisplay).toBeUndefined();
    expect(p.isFileDiff).toBe(false);
  });

  it("keeps a deleted file card title-only", () => {
    const p = presentTool(
      toolItem({
        name: "fs.delete",
        argsDisplay: "/Users/me/todo-app/src/obsolete.ts",
        status: "ok",
        fileChanges: [
          {
            path: "/Users/me/todo-app/src/obsolete.ts",
            basename: "obsolete.ts",
            kind: "delete",
            stats: { oldLines: 1, newLines: 0, added: 0, removed: 1 },
            previewHunks: [],
            addedNewLines: [],
            deletedAt: [],
            afterText: "",
          },
        ],
      }),
    );
    expect(p.name).toBe("Deleted obsolete.ts");
    expect(p.isFileDiff).toBe(false);
  });

  it("does not turn an incomplete edit path into a filename", () => {
    const p = presentTool(
      toolItem({ name: "fs.edit", argsDisplay: "edit", status: "queued" }),
    );
    expect(p.name).toBe("Editing");
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

  it("removes printable caret-encoded CSI from captured tool output", () => {
    const raw = "passed^[[39m^[[22m^[[90m (104)^[[39m";
    expect(cleanToolOutputLines(raw)).toEqual(["passed (104)"]);
  });

  it("preserves incomplete caret notation used as ordinary text", () => {
    expect(cleanToolOutputLines("press ^[ then [39m")).toEqual(["press ^[ then [39m"]);
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

  it("keeps web.search evidence at top when collapsed (R5)", () => {
    const body = [
      "duckduckgo: 5 results",
      "",
      '  "title": "Official UK PM"',
      '  "url": "https://www.gov.uk/government/ministers/prime-minister"',
      '  "title": "News junk"',
      '  "url": "https://example-seo.example/pm"',
      ...Array.from({ length: 20 }, (_, i) => `noise line ${i}`),
    ].join("\n");
    const p = presentOutput(body, undefined, false, "web.search");
    expect(p.lines[0]).toMatch(/duckduckgo|results/i);
    expect(p.lines.some((l) => l.includes("gov.uk"))).toBe(true);
    expect(p.lines.some((l) => l.startsWith("···"))).toBe(true);
    const ev = evidencePreviewLines("web.search", body.split("\n"));
    expect(ev?.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps web.fetch title/lede when collapsed (R5)", () => {
    const body = [
      "HTTP 200 OK",
      "Title: Prime Minister - GOV.UK",
      "",
      "The Prime Minister is the head of the UK government.",
      "More body content about duties and history.",
      "Even more content.",
      ...Array.from({ length: 30 }, (_, i) => `paragraph ${i}`),
    ].join("\n");
    const p = presentOutput(body, undefined, false, "web.fetch");
    expect(p.lines[0]).toMatch(/HTTP 200|Title/i);
    expect(p.lines.some((l) => /Prime Minister is the head/i.test(l))).toBe(
      true,
    );
  });

  it("does not show ok/failed status lines in the body", () => {
    const p = presentOutput("hello\nok\nfailed\n", undefined, true);
    expect(p.lines).toEqual(["hello"]);
  });
});

describe("failed file mutations surface why they failed", () => {
  const path =
    "/Users/aniketpandey/Desktop/project/AD-Attack-Detection-Lab-Recipebook.md";

  function failedAppend(summary: string) {
    return presentTool(
      toolItem({
        name: "fs.append",
        status: "failed",
        summary,
        argsDisplay: path,
      }),
    );
  }

  it("keeps a long precondition mismatch readable instead of dropping it", () => {
    const presented = failedAppend(
      "fs.append integrity check failed: expected prior bytes=69713, actual=70120. " +
        `Re-send only the missing content with expectedPriorBytes=70120. (${path})`,
    );

    expect(presented.name).toBe(
      "Append failed · AD-Attack-Detection-Lab-Recipebook.md",
    );
    expect(presented.detail).toContain("expected prior bytes=69713");
    expect(presented.detail).toContain("actual=70120");
    expect(presented.detail!.length).toBeLessThanOrEqual(120);
  });

  it("keeps an elided-placeholder rejection readable", () => {
    const presented = failedAppend(
      'Tool call rejected: argument "args.content" is an elided history ' +
        "placeholder («N chars sha256=…»), not a real value. Compressed history " +
        "replaces long arguments with those stubs.",
    );

    expect(presented.detail).toContain("elided history placeholder");
    expect(presented.detail!.endsWith("…")).toBe(true);
  });

  it("still omits artifact pointers", () => {
    const presented = failedAppend("Full output saved to /tmp/x.txt");
    expect(presented.detail).toBeUndefined();
  });
});
