import { describe, expect, it } from "vitest";
import {
  preprocessAssistantMarkdown,
  renderMarkdownLines,
} from "../../../src/tui-v2/rendering/render-markdown-lines.js";

function plain(lines: ReturnType<typeof renderMarkdownLines>): string {
  return lines.map((st) => st.chunks.map((c) => c.text).join("")).join("\n");
}

describe("preprocessAssistantMarkdown", () => {
  it("normalizes br variants and paragraph tags", () => {
    expect(preprocessAssistantMarkdown("a<br/>b")).toContain("<br>");
    expect(preprocessAssistantMarkdown("a</p><p>b")).toContain("\n\n");
  });
});

describe("renderMarkdownLines (classic parity for OpenTUI)", () => {
  it("expands <br> into separate lines (no literal br tag)", () => {
    const lines = renderMarkdownLines("alpha<br>beta", {
      width: 80,
      stripOuterIndent: true,
    });
    const text = plain(lines);
    expect(text).not.toContain("<br>");
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it("renders markdown tables with box borders", () => {
    const md = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    const text = plain(
      renderMarkdownLines(md, { width: 80, stripOuterIndent: true }),
    );
    expect(text).toContain("│");
    expect(text).toContain("a");
    expect(text).toContain("b");
    expect(text).toContain("1");
    expect(text).toContain("2");
    expect(text).toMatch(/[┌├└]/);
  });

  it("shrinks wide tables to the chat wrap budget (plan pane adjacent)", () => {
    // Wide multi-column table must not overflow a narrow chat column when the
    // plan/task pane is open beside it (chatContentWidth ~ 60–72).
    const md = [
      "| Feature | Default | Wide notes that would overflow without wrapping |",
      "| --- | --- | --- |",
      "| Alpha | yes | long description that is intentionally verbose for width stress |",
      "| Beta | no | another long cell that needs to shrink into the available columns |",
    ].join("\n");
    const budget = 64;
    const lines = renderMarkdownLines(md, {
      width: budget,
      stripOuterIndent: true,
    });
    const text = plain(lines);
    expect(text).toMatch(/[┌├└]/);
    // Visible width of every physical row stays within the wrap budget.
    // (ANSI codes are already stripped by plain(); string length ≈ columns.)
    for (const line of text.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(budget);
    }
  });

  it("expands <br> inside table cells without leaking the tag", () => {
    const md =
      "| Item | Notes |\n| --- | --- |\n| One | first<br>second<br>third |";
    const text = plain(
      renderMarkdownLines(md, { width: 80, stripOuterIndent: true }),
    );
    expect(text).not.toContain("<br>");
    expect(text).toContain("first");
    expect(text).toContain("second");
    expect(text).toContain("third");
  });

  it("strips bold markers and keeps list bullets", () => {
    const text = plain(
      renderMarkdownLines("**Note:** be careful\n\n- one\n- two", {
        width: 80,
        stripOuterIndent: true,
      }),
    );
    expect(text).not.toContain("**");
    expect(text).toContain("Note:");
    expect(text).toContain("•");
    expect(text).toContain("one");
  });

  it("applies defaultFg to uncolored body text", () => {
    const lines = renderMarkdownLines("hello world", {
      width: 80,
      defaultFg: "#4ADE80",
      stripOuterIndent: true,
    });
    expect(lines[0]?.chunks[0]?.fg).toBeDefined();
  });
});
