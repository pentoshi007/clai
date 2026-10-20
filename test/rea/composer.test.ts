import type { TextareaRenderable } from "@opentui/core";
import { SyntaxStyle } from "@opentui/core";
import { describe, expect, it, vi } from "vitest";
import { paintDraftMentions } from "../../src/tui-v2/composer/composer-highlight.js";

vi.mock("@opentui/core", () => ({
  SyntaxStyle: {
    fromStyles: vi.fn(() => ({ resolveStyleId: () => 1 })),
  },
}));

function paint(text: string) {
  const editor = {
    clearAllHighlights: vi.fn(),
    addHighlightByCharRange: vi.fn(),
    syntaxStyle: undefined,
  };
  paintDraftMentions({
    editor: editor as unknown as TextareaRenderable,
    text,
    skills: new Set(),
    servers: new Set(),
    skillColor: "#ffff00",
    serverColor: "#00ffff",
  });
  return editor;
}

describe("OpenTUI REA composer paint", () => {
  it("paints an editable REA token with the MCP style before the server exists", () => {
    const editor = paint("inspect /rea this artifact");
    expect(editor.clearAllHighlights).toHaveBeenCalledOnce();
    expect(editor.addHighlightByCharRange).toHaveBeenCalledExactlyOnceWith({
      start: 8, end: 12, styleId: 1, priority: 100,
    });
    expect(SyntaxStyle.fromStyles).toHaveBeenCalledWith(expect.objectContaining({
      "clai.mcp.mention": { fg: "#00ffff", bold: true },
    }));
  });

  it("does not paint paths and URLs and clears a removed token", () => {
    paint("/rea inspect");
    const editor = paint("read /rea/README.md or https://example.test/rea");
    expect(editor.addHighlightByCharRange).not.toHaveBeenCalled();
    const cleared = paint("ordinary source work");
    expect(cleared.clearAllHighlights).toHaveBeenCalledOnce();
    expect(cleared.addHighlightByCharRange).not.toHaveBeenCalled();
  });
});
