import { describe, expect, it } from "vitest";
import {
  preprocessAssistantMarkdown,
  renderMarkdownLines,
} from "../../../src/ui-core/rendering/render-markdown-lines.js";

const SGR = /\x1b\[[0-9;]*m/g;

function plain(lines: ReturnType<typeof renderMarkdownLines>): string {
  return lines.map((line) => line.replace(SGR, "")).join("\n");
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

  it("returns one ANSI line per physical row and never an empty string", () => {
    const lines = renderMarkdownLines("hello world\n\nsecond paragraph", {
      width: 80,
      stripOuterIndent: true,
    });
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(typeof line).toBe("string");
      expect(line.length).toBeGreaterThan(0);
    }
  });
});

describe("explicit markdown appearance", () => {
  it("is independent of ambient theme and chalk state and isolates code-row palettes", async () => {
    const [{ default: chalk }, { themeFor }] = await Promise.all([
      import("chalk"),
      import("../../../src/ui-core/rendering/theme.js"),
    ]);
    const previousLevel = chalk.level;
    const previousTheme = process.env.CLAI_THEME;
    const source = "```ts\nconst value = 42;\n```";

    try {
      chalk.level = 0;
      process.env.CLAI_THEME = "light";
      const first = renderMarkdownLines(source, {
        width: 72,
        stripOuterIndent: true,
        theme: themeFor("dark"),
        colorMode: "truecolor",
      });
      expect(chalk.level).toBe(0);

      chalk.level = 3;
      process.env.CLAI_THEME = "dark";
      const second = renderMarkdownLines(source, {
        width: 72,
        stripOuterIndent: true,
        theme: themeFor("dark"),
        colorMode: "truecolor",
      });
      const light = renderMarkdownLines(source, {
        width: 72,
        stripOuterIndent: true,
        theme: themeFor("light"),
        colorMode: "truecolor",
      });
      const colorless = renderMarkdownLines(source, {
        width: 72,
        stripOuterIndent: true,
        theme: themeFor("dark"),
        colorMode: "none",
      });

      expect(second).toEqual(first);
      expect(light).not.toEqual(first);
      expect(first.join("\n")).toContain("\x1b[");
      expect(colorless.join("\n")).not.toContain("\x1b[");
      expect(chalk.level).toBe(3);
    } finally {
      chalk.level = previousLevel;
      if (previousTheme === undefined) delete process.env.CLAI_THEME;
      else process.env.CLAI_THEME = previousTheme;
    }
  });
});
