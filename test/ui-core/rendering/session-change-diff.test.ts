import { stripVTControlCharacters } from "node:util";
import { Chalk } from "chalk";
import { describe, expect, it } from "vitest";
import { SessionChanges } from "../../../src/app/controllers/session-changes.js";
import { buildFileChange, INLINE_AFTER_MAX_BYTES } from "../../../src/tools/file-diff.js";
import { formatSessionChanges } from "../../../src/ui-core/commands/change-commands.js";
import { syntaxColor } from "../../../src/ui-core/rendering/file-diff-view.js";
import { renderMarkdownLines } from "../../../src/ui-core/rendering/render-markdown-lines.js";
import { sessionChangeDiff } from "../../../src/ui-core/rendering/session-change-diff.js";
import { themeFor } from "../../../src/ui-core/rendering/theme.js";

const theme = themeFor("dark");
const paint = new Chalk({ level: 3 });
const numbered = (count: number) => Array.from({ length: count }, (_, index) => `const v${index} = ${index};`).join("\n") + "\n";

function render(body: string, width = 80, colorMode: "truecolor" | "none" = "truecolor"): string[] {
  return renderMarkdownLines(body, {
    width, stripOuterIndent: true, theme, colorMode,
    quotePrefix: "", literalQuotes: true, lineChangeColors: true, diffLines: true,
  });
}

const openSeq = (color: string, background = false) =>
  (background ? paint.bgHex(color) : paint.hex(color))("\u0000").split("\u0000")[0]!;

describe("session change diffs", () => {
  it("shows every change of an edit with three lines of context and gaps between distant hunks", () => {
    const before = numbered(40);
    const after = before.replace("const v5 = 5;", "const v5 = 50;").replace("const v30 = 30;\n", "");
    const lines = sessionChangeDiff(buildFileChange({ path: "/repo/a.ts", before, after, kind: "edit" })).split("\n");
    expect(lines[0]).toBe("   │ edit · /repo/a.ts");
    expect(lines).toContain(" 6 │ − const v5 = 5;");
    expect(lines).toContain(" 6 │ + const v5 = 50;");
    expect(lines).toContain("31 │ − const v30 = 30;");
    expect(lines).toContain(" 3 │   const v2 = 2;");
    expect(lines).not.toContain(" 2 │   const v1 = 1;");
    expect(lines).toContain("   │ ⋯");
    expect(lines.length).toBeLessThan(20);
    expect(lines.join("\n")).not.toContain("not kept");
  });

  it("falls back to the kept preview hunks and says how much was not kept for oversized files", () => {
    const before = Array.from({ length: 1_200 }, (_, index) => `export const value${index} = "${"v".repeat(40)}";`).join("\n") + "\n";
    const after = before.split("\n").map((line, index) => index % 50 === 0 ? line.replace("export const", "export let") : line).join("\n");
    expect(Buffer.byteLength(after)).toBeGreaterThan(INLINE_AFTER_MAX_BYTES);
    const change = buildFileChange({ path: "/repo/big.ts", before, after, kind: "edit" });
    expect(change.afterText).toBeUndefined();
    const text = sessionChangeDiff(change);
    expect(text.split("\n")[0]).toContain("│ edit · /repo/big.ts");
    expect(text).toMatch(/ 1 │ − export const value0 = /);
    expect(text).toMatch(/ 1 │ \+ export let value0 = /);
    expect(text).toMatch(/51 │ \+ export let value50 = /);
    expect(text).toMatch(/⋯ \d+ more changed lines not kept for this edit$/);
    expect(sessionChangeDiff(change)).toBe(text);
  });

  it("lists totals and files first, then each file's counts and diffs in order", () => {
    const ledger = new SessionChanges();
    ledger.record("one", [buildFileChange({ path: "/repo/b.py", before: "", after: "def main():\n    return 1\n", kind: "create" })]);
    ledger.record("two", [buildFileChange({ path: "/repo/a.ts", before: "let a = 1;\n", after: "const a = 1;\n", kind: "edit" })]);
    ledger.restore([...ledger.snapshot().files, { path: "/repo/c.md", added: 1, removed: 0 }], [
      { kind: "tool", id: "t1", name: "fs.write", argsDisplay: "b.py", output: "", status: "ok", done: true,
        fileChanges: [buildFileChange({ path: "/repo/b.py", before: "", after: "def main():\n    return 1\n", kind: "create" })] },
      { kind: "tool", id: "t2", name: "fs.edit", argsDisplay: "a.ts", output: "", status: "ok", done: true,
        fileChanges: [buildFileChange({ path: "/repo/a.ts", before: "let a = 1;\n", after: "const a = 1;\n", kind: "edit" })] },
    ]);
    const body = formatSessionChanges(ledger.snapshot());
    expect(formatSessionChanges(ledger.snapshot())).toBe(body);
    const order = ["**Total** · **+4 -1** · 3 files", "> +1 -1  /repo/a.ts", "> +2 -0  /repo/b.py", "> +1 -0  /repo/c.md", "---",
      "> +1 -1  /repo/a.ts", "│ edit · /repo/a.ts", "1 │ + const a = 1;", "> +2 -0  /repo/b.py", "│ create · /repo/b.py",
      "1 │ + def main():", "> +1 -0  /repo/c.md", " │ diff not kept in this session"];
    let cursor = -1;
    for (const text of order) {
      const next = body.indexOf(text, cursor + 1);
      expect(next, text).toBeGreaterThan(cursor);
      cursor = next;
    }
  });

  it("renders diff rows with gutters, washes and per-file syntax colours in the shared markdown renderer", () => {
    const ts = sessionChangeDiff(buildFileChange({ path: "/repo/a.ts", before: "let a = 1;\n", after: "const a = 1;\n", kind: "edit" }));
    const py = sessionChangeDiff(buildFileChange({ path: "/repo/b.py", before: "", after: "def main():\n", kind: "create" }));
    const rows = render(`# Session changes\n\n> +2 -1  files\n\n${ts}\n${py}`);
    const plain = rows.map((row) => stripVTControlCharacters(row).trimEnd());
    expect(plain).toContain("  │ edit · /repo/a.ts");
    expect(plain).toContain("1 │ - let a = 1;");
    expect(plain).toContain("1 │ + const a = 1;");
    expect(plain).toContain("1 │ + def main():");
    const added = rows[plain.indexOf("1 │ + const a = 1;")]!;
    const removed = rows[plain.indexOf("1 │ - let a = 1;")]!;
    expect(added.startsWith(openSeq(theme.diffAddBg, true))).toBe(true);
    expect(removed.startsWith(openSeq(theme.diffDelBg, true))).toBe(true);
    expect(added).toContain(`${openSeq(syntaxColor("keyword", theme))}const`);
    expect(added).toContain(`${openSeq(theme.diffAdd)}│ `);
    expect(stripVTControlCharacters(added).length).toBe(78);
    const python = rows[plain.indexOf("1 │ + def main():")]!;
    expect(python).toContain(`${openSeq(syntaxColor("keyword", theme))}def`);
    expect(rows[plain.indexOf("  │ edit · /repo/a.ts")]).toContain(`${openSeq(theme.muted)}edit · /repo/a.ts`);
    expect(rows.find((row) => stripVTControlCharacters(row).startsWith("+2 -1"))).toContain(`${openSeq(theme.success)}+2`);
  });

  it("wraps long diff lines under the code column and keeps plain text when colour is off", () => {
    const change = buildFileChange({ path: "/repo/a.ts", before: "", after: `const long = "${"x".repeat(90)}";\n`, kind: "create" });
    const plain = render(sessionChangeDiff(change), 40, "none");
    expect(plain.join("")).not.toContain("\u001b[");
    expect(plain[1]).toMatch(/^1 │ \+ const long/);
    expect(plain[2]).toMatch(/^ {2}│ {3}"x/);
    expect(plain.slice(1).map((row) => row.replace(/^[\d ]* │ [+ ] /, "")).join("")).toBe(`const long = "${"x".repeat(90)}";`);
  });

  it("leaves bodies without the diff flag to the ordinary markdown rules", () => {
    const rows = renderMarkdownLines("  1 │ + <br>value", { width: 60, stripOuterIndent: true, theme, colorMode: "none" });
    expect(rows.join("\n")).not.toContain("<br>");
    expect(render("  1 │ + <br>value", 60, "none")).toEqual(["  1 │ + <br>value"]);
  });
});
