import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import {
  renderInlineMarkdown,
  renderMarkdown,
  createMarkdownStreamWriter,
  wrapAnsiLine,
} from "../src/ui/markdown.js";

function strip(text: string): string {
  // biome-ignore lint: ANSI escape sequences are intentional.
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("inline markdown rendering", () => {
  it("strips bold markers from output", () => {
    const rendered = renderInlineMarkdown("hello **world**");
    expect(strip(rendered)).toBe("hello world");
  });

  it("does not render literal asterisks for **bold**", () => {
    expect(renderInlineMarkdown("**bold**")).not.toContain("**");
  });

  it("renders inline code without backticks bleeding through", () => {
    expect(strip(renderInlineMarkdown("use `npm test` now"))).toBe(
      "use npm test now",
    );
  });

  it("renders italics for *word* but leaves `a * b` math alone", () => {
    expect(strip(renderInlineMarkdown("*emph*"))).toBe("emph");
    expect(strip(renderInlineMarkdown("a * b * c"))).toBe("a * b * c");
  });

  it("preserves snake_case identifiers", () => {
    expect(strip(renderInlineMarkdown("call my_function() now"))).toBe(
      "call my_function() now",
    );
  });

  it("renders links as label(url)", () => {
    const rendered = strip(renderInlineMarkdown("see [docs](https://x)"));
    expect(rendered).toBe("see docs(https://x)");
  });
});

describe("block markdown rendering", () => {
  it("emits fenced code blocks with header and footer", () => {
    const md = "```bash\nls -la\n```";
    const out = strip(renderMarkdown(md));
    expect(out).toContain("bash");
    expect(out).toContain("ls -la");
    // Code lines are preserved as-is, no stray triple-backticks.
    expect(out).not.toContain("```");
  });

  it("renders headings without the # markers", () => {
    expect(strip(renderMarkdown("# Title\nbody"))).toContain("Title");
    expect(strip(renderMarkdown("# Title\nbody"))).not.toContain("#");
  });

  it("renders ordered and unordered lists", () => {
    const out = strip(renderMarkdown("- one\n- two"));
    expect(out).toContain("• one");
    expect(out).toContain("• two");
    const ordered = strip(renderMarkdown("1. first\n2. second"));
    expect(ordered).toContain("1. first");
    expect(ordered).toContain("2. second");
  });
});

describe("markdown stream writer", () => {
  it("renders bold text once a complete line arrives", () => {
    let out = "";
    const writer = createMarkdownStreamWriter((chunk) => {
      out += chunk;
    });
    writer.push("hello **world**");
    writer.push("\n");
    expect(strip(out)).toBe("  hello world\n");
  });

  it("flushes pending fenced content on finish", () => {
    let out = "";
    const writer = createMarkdownStreamWriter((chunk) => {
      out += chunk;
    });
    writer.push("```bash\necho hi\n");
    writer.finish();
    expect(strip(out)).toContain("echo hi");
  });
});

describe("markdown extras", () => {
  it("renders inline markdown inside headings", () => {
    const out = strip(renderMarkdown("## Important **note**"));
    expect(out).toBe("  Important note");
  });

  it("renders task list checkboxes", () => {
    const out = strip(renderMarkdown("- [ ] todo\n- [x] done"));
    expect(out).toContain("☐ todo");
    expect(out).toContain("☑ done");
  });

  it("renders simple markdown tables", () => {
    const md = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    const out = strip(renderMarkdown(md));
    expect(out).toContain("│ a │ b │");
    expect(out).toContain("│ 1 │ 2 │");
  });

  it("draws aligned box borders around a table", () => {
    const md = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    const out = strip(renderMarkdown(md));
    expect(out).toContain("┌");
    expect(out).toContain("┬");
    expect(out).toContain("├");
    expect(out).toContain("┼");
    expect(out).toContain("└");
    expect(out).toContain("┴");
  });

  it("expands <br> inside a table cell into stacked lines (no literal <br>)", () => {
    const md =
      "| Item | Notes |\n| --- | --- |\n| One | first<br>second<br>third |";
    const out = strip(renderMarkdown(md));
    expect(out).not.toContain("<br>");
    expect(out).toContain("first");
    expect(out).toContain("second");
    expect(out).toContain("third");
    // The three sub-lines occupy three separate physical rows.
    const firstLine = out.split("\n").find((l) => l.includes("first"))!;
    expect(firstLine).not.toContain("second");
  });

  it("expands <br> outside tables into separate lines", () => {
    const out = strip(renderMarkdown("alpha<br>beta"));
    expect(out).not.toContain("<br>");
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    expect(out.split("\n").length).toBeGreaterThanOrEqual(2);
  });

  it("renders tables identically through the streaming writer", () => {
    const md = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
    let streamed = "";
    const writer = createMarkdownStreamWriter((chunk) => {
      streamed += chunk;
    });
    for (const ch of md) writer.push(ch);
    writer.finish();
    const out = strip(streamed);
    expect(out).toContain("│ a │ b │");
    expect(out).toContain("│ 1 │ 2 │");
    expect(out).toContain("┌");
  });

  it("strips bold markers in real-world phrases like **Word:**", () => {
    expect(strip(renderInlineMarkdown("**Note:** be careful"))).toBe(
      "Note: be careful",
    );
  });

  it("splits extremely long words without spaces to avoid layout overflow", () => {
    const longWord = "a".repeat(100);
    const wrapped = wrapAnsiLine(longWord, 40);
    expect(wrapped.length).toBe(3);
    expect(wrapped[0]).toBe("a".repeat(40));
    expect(wrapped[1]).toBe("a".repeat(40));
    expect(wrapped[2]).toBe("a".repeat(20));
  });

  it("renders list items formatted inside table cells", () => {
    const md =
      "| Key points |\n| --- |\n| * item one<br>- item two<br>1. item three |";
    const out = strip(renderMarkdown(md));
    // Should render a cyan bullet (•) or number (1.)
    expect(out).toContain("• item one");
    expect(out).toContain("• item two");
    expect(out).toContain("1. item three");
  });

  it("keeps table borders aligned when cells contain wide emoji glyphs", () => {
    // Emoji like ✅/⚠️/❓ render as 2 terminal columns but are 1-2 JS chars;
    // under-counting them used to desync column widths and let the TUI's
    // own width-aware truncation clip borders on some rows but not others.
    const md =
      "| Vulnerability | Status |\n| --- | --- |\n" +
      "| UUID Enumeration | ✅ CONFIRMED |\n" +
      "| Document Endpoints | ⚠️ PARTIAL |\n" +
      "| Email Sending | ❓ UNVERIFIED |";
    const out = strip(renderMarkdown(md, 80));
    const lines = out.split("\n").filter((l) => l.trim().length > 0);
    const widths = lines.map((l) => stringWidth(l));
    // Every row (borders, header, body) must be the exact same visible width
    // so the box stays a clean rectangle instead of a jagged/clipped shape.
    expect(new Set(widths).size).toBe(1);
    for (const line of lines) {
      expect(
        line.endsWith("│") ||
          line.endsWith("┐") ||
          line.endsWith("┘") ||
          line.endsWith("┤"),
      ).toBe(true);
    }
  });

  it("never renders a table wider than the requested width, even with wide glyphs", () => {
    const md =
      "| Vulnerability | Status | Evidence |\n| --- | --- | --- |\n" +
      "| UUID Enumeration | ✅ CONFIRMED | /api/v1/data_layer/patients/by-image/{uuid} returns not found for valid UUID format vs validation error for invalid format |\n" +
      "| Debug Mode Enabled | ⚠️ PARTIAL | Error responses leak internal validation details and field requirements |";
    const width = 60;
    const out = strip(renderMarkdown(md, width));
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      expect(stringWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("renders formatting properly even when text spans across wrap boundaries", () => {
    const md =
      "This is a **comprehensive guide for students to access premium AI models** that spans a long line.";
    const out = renderMarkdown(md, 40);
    // The rendered output should have the bold markers stripped (because it was parsed first)
    expect(strip(out)).not.toContain("**");
    expect(strip(out)).toContain("comprehensive guide");
  });

  it("wraps and aligns ordered and unordered list items to avoid truncation", () => {
    const md =
      "1. OpenCode + GitHub Copilot — Terminal-based AI coding agent; connect it to your free Copilot account and select Claude Opus/Sonnet/H";
    const out = renderMarkdown(md, 40);
    expect(strip(out)).toContain("1. OpenCode +");
    // The wrapped lines should be indented by 3 spaces (since prefix is '1. ')
    const lines = out.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[1]).toMatch(/^\s{5}\w+/); // 2 spaces (OUTPUT_INDENT) + 3 spaces (prefix length)
  });

  it("wraps and aligns blockquotes correctly", () => {
    const md =
      "> This is a very long blockquote line that should be wrapped across multiple lines of text.";
    const out = renderMarkdown(md, 40);
    const lines = out.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) {
      expect(strip(l)).toContain("│");
    }
  });
});
