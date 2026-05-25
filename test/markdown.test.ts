import { describe, expect, it } from "vitest";
import {
  renderInlineMarkdown,
  renderMarkdown,
  createMarkdownStreamWriter,
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

  it("strips bold markers in real-world phrases like **Word:**", () => {
    expect(strip(renderInlineMarkdown("**Note:** be careful"))).toBe(
      "Note: be careful",
    );
  });
});
