import { describe, expect, it } from "vitest";
import { preparePagerDisplay } from "../../../src/tui-v2/rendering/pager-markdown.js";
import {
  extractFsReadFileBody,
  looksLikeMarkdown,
  stripPagerLineGutters,
} from "../../../src/ui-core/rendering/pager-source.js";
import { formatShortcutsReference } from "../../../src/ui-core/actions/format-shortcuts.js";
import { formatCommandHelpMarkdown } from "../../../src/ui-core/rendering/format-help.js";
import { renderMarkdown } from "../../../src/ui-core/rendering/markdown.js";
import { stripAnsiSequences } from "../../../src/ui-core/rendering/sanitize-display.js";
import { findPagerMatches } from "../../../src/ui-core/state/pager-search.js";

describe("stripPagerLineGutters", () => {
  it("removes file-modal line numbers so markdown can render", () => {
    const raw = [
      "  1 │ # Title",
      "  2 │ ",
      "  3 │ **bold** text",
      " 12 │ | a | b |",
    ].join("\n");
    expect(stripPagerLineGutters(raw)).toBe(
      ["# Title", "", "**bold** text", "| a | b |"].join("\n"),
    );
  });

  it("leaves non-guttered bodies alone", () => {
    const body = "# Compacted\n\n- item one\n";
    expect(stripPagerLineGutters(body)).toBe(body);
  });

});

describe("extractFsReadFileBody", () => {
  it("strips tool chrome and line numbers for markdown render", () => {
    const raw = [
      "# fs.read path=/tmp/findings.md lines=1-4 of 4 bytes=99",
      "1: # VAPT Findings",
      "2: ",
      "3: ## F2 — SSRF",
      "4: - **Severity**: MEDIUM",
      "# hasMore=false",
    ].join("\n");
    expect(extractFsReadFileBody(raw)).toBe(
      ["# VAPT Findings", "", "## F2 — SSRF", "- **Severity**: MEDIUM"].join(
        "\n",
      ),
    );
  });
});

describe("looksLikeMarkdown", () => {
  it("accepts structured docs", () => {
    expect(
      looksLikeMarkdown("# Title\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n"),
    ).toBe(true);
    expect(looksLikeMarkdown("## Section\n\n- item one\n\n- item two\n")).toBe(
      true,
    );
  });

  it("rejects plain tool/log dumps and path-heavy text", () => {
    expect(
      looksLikeMarkdown(
        "saved /Users/me/project/src/file_with_underscores.ts\nok\n",
      ),
    ).toBe(false);
    expect(
      looksLikeMarkdown("npm install * && echo done\nline two\nline three\n"),
    ).toBe(false);
  });
});

describe("preparePagerDisplay", () => {
  it("force-renders markdown without throwing", () => {
    const body = formatShortcutsReference();
    const prep = preparePagerDisplay({
      body,
      width: 72,
      mode: "force",
      defaultFg: "#e5e5e5",
    });
    expect(prep.mode).toBe("markdown");
    expect(prep.lines.length).toBeGreaterThan(5);
    expect(prep.lines.some((l) => /Keyboard|Global|Ctrl/i.test(l.plain))).toBe(
      true,
    );
    // Styled rows present for visual paint
    expect(prep.lines.some((l) => l.styled)).toBe(true);
  });

  it("keeps plain tool output as plain (auto)", () => {
    const body = [
      "Created /tmp/project/src/index.ts",
      "  bytes=21 lines=2 sha256_12=abc",
      "  ends_with: \"export const n = 42;\"",
    ].join("\n");
    const prep = preparePagerDisplay({ body, width: 80, mode: "auto" });
    expect(prep.mode).toBe("plain");
    expect(prep.lines.map((l) => l.plain).join("\n")).toContain("bytes=21");
  });

  it("never throws on garbage input", () => {
    expect(() =>
      preparePagerDisplay({
        body: "```\nunclosed fence\n**bold",
        width: 40,
        mode: "force",
      }),
    ).not.toThrow();
  });

  it("plain mode never uses markdown", () => {
    const prep = preparePagerDisplay({
      body: "# Heading\n\n**bold**",
      width: 60,
      mode: "plain",
    });
    expect(prep.mode).toBe("plain");
    expect(prep.lines[0]?.plain).toContain("# Heading");
  });
});

describe("pager search against markdown-rendered help", () => {
  it("finds terms in rendered help/list plain text (incl. box-drawing lines)", () => {
    const md = formatCommandHelpMarkdown([
      {
        command: "/output",
        usage: "[last|<id>|list]",
        description: "open full tool output",
        aliases: [],
      },
      {
        command: "/cwd",
        usage: "<path>",
        description: "change working directory",
        aliases: [],
      },
    ]);
    // What the user sees after markdown paint, as plain searchable text.
    const plain = stripAnsiSequences(renderMarkdown(md, 72));
    const lines = plain.replace(/\n+$/, "").split("\n");
    const outHits = findPagerMatches(lines, "output");
    const cwdHits = findPagerMatches(lines, "cwd");
    expect(outHits.length).toBeGreaterThan(0);
    expect(cwdHits.length).toBeGreaterThan(0);
    // Box-drawing table rows (if any) must still be searchable as full lines.
    const boxLines = lines.filter((l) => l.includes("│"));
    if (boxLines.length > 0) {
      // Searching the full line (not a false "diff code" slice) still works.
      const sample = boxLines[0]!;
      const token = sample.replace(/[^\w/]+/g, " ").trim().split(/\s+/)[0];
      if (token && token.length >= 2) {
        expect(findPagerMatches([sample], token.toLowerCase()).length).toBeGreaterThan(0);
      }
    }
  });
});

describe("formatCommandHelpMarkdown", () => {
  it("groups commands into sections as lists (not tables)", () => {
    const md = formatCommandHelpMarkdown([
      {
        command: "/help",
        description: "list commands",
        aliases: [],
      },
      {
        command: "/model",
        usage: "[name]",
        description: "pick a model",
        aliases: [],
      },
      {
        command: "/ask",
        description: "switch to ask",
        aliases: [],
      },
      {
        command: "/output",
        usage: "[last|<id>|list]",
        description: "open full tool output",
        aliases: [],
      },
      {
        command: "/cwd",
        usage: "<path>",
        description: "change working directory",
        aliases: [],
      },
    ]);
    expect(md).toMatch(/^# Commands/m);
    expect(md).toMatch(/## Mode & plan/);
    expect(md).toMatch(/## Model & providers/);
    expect(md).toMatch(/## Session/);
    // List items — never markdown tables (pipes in usage break tables).
    expect(md).not.toContain("| Command | Description |");
    expect(md).toContain("- `/help` — list commands");
    expect(md).toContain("- `/output [last|<id>|list]` — open full tool output");
    expect(md).toContain("- `/cwd <path>` — change working directory");
    // Pipe/angle usage must stay on one list line.
    const outputLine = md.split("\n").find((l) => l.includes("/output"));
    expect(outputLine).toBeDefined();
    expect(outputLine!.startsWith("- `")).toBe(true);
    expect(outputLine!.split("|").length).toBeGreaterThan(2); // usage pipes only
  });
});
