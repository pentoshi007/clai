import { describe, expect, it } from "vitest";
import { renderMarkdownLines } from "../../../src/ui-core/rendering/render-markdown-lines.js";
import { codeBlockCopyAt, copyableSelectionText } from "../../../src/ui-core/rendering/code-block-copy.js";
import { plainText } from "../../../src/classic/render/ansi-text.js";

const BODY = [
  "curl -fsSL https://example.com/some/really/long/path/to/install.sh?token=abc123&mode=full | bash -s -- --yes",
  "npm install --save-dev typescript @types/node vitest eslint prettier tsx  two  spaces   three",
  "    indented(call, with, many, args, that, keep, going, and, going, forever, and, ever)",
  "",
  "https://github.com/pentoshi007/clai/pull/123/files#diff-abcdef0123456789abcdef0123456789abcdef",
  "日本語のテキストがとても長い行になって折り返されるかどうかを確認するための文章です",
  "a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x,y,z,aa,bb,cc,dd,ee,ff,gg,hh,ii,jj",
].join("\n");

const render = (width: number, copyLabel = true): string[] =>
  renderMarkdownLines(`Run:\n\n\`\`\`bash\n${BODY}\n\`\`\`\n\nDone.`, {
    width,
    stripOuterIndent: true,
    copyLabel,
  }).map(plainText);

describe("code block copy", () => {
  it.each([24, 30, 41, 60, 80, 120])("restores the exact source from a wrapped block at %i columns", (width) => {
    const lines = render(width);
    expect(lines.some((line) => line.includes("↪"))).toBe(width < 110);
    expect(copyableSelectionText(lines.join("\n"))).toBe(`Run:\n \n${BODY}\n \nDone.`);
  });

  it.each([24, 41, 80])("copies the whole block from its copy tab at %i columns", (width) => {
    const lines = render(width);
    const header = lines.findIndex((line) => line.includes("╭"));
    const column = lines[header]!.indexOf(" copy ");
    expect(codeBlockCopyAt(lines, header, column)).toBe(BODY);
    expect(codeBlockCopyAt(lines, header, column + 5)).toBe(BODY);
    expect(codeBlockCopyAt(lines, header, column - 1)).toBeUndefined();
    expect(codeBlockCopyAt(lines, header + 1, column)).toBeUndefined();
  });

  it("omits the copy tab unless requested", () => {
    const lines = render(60, false);
    const header = lines.find((line) => line.includes("╭"))!;
    expect(header).not.toContain("copy");
    expect(copyableSelectionText(lines.join("\n"))).toBe(`Run:\n \n${BODY}\n \nDone.`);
  });

  it.each([
    ["a selection that starts inside a row", "/some │\n│ ↪/really/long │\n╰───────────────╯", "/some/really/long"],
    ["a selection inside one block", "ple.com/some │\n│ ↪/really/lo", "ple.com/some/really/lo"],
    ["one full row", "│ npm test   │", "npm test"],
    ["the start of one row", "│ npm te", "npm te"],
    ["a selection ending inside a block", "╭─ bash ── copy ─╮\n│ npm install    │\n│ ↪ typescript   │\n│ ls -la", "npm install typescript\nls -la"],
    ["a selection starting inside the header", "── copy ─╮\n│ a b    │\n╰────────╯", "a b"],
    ["prose around a block", "Run:\n╭─ sh ───╮\n│ ls     │\n╰────────╯\nDone.", "Run:\nls\nDone."],
    ["a block after a transcript marker", "* ╭─ sh ───╮\n  │ ls     │\n  ╰────────╯", "ls"],
  ])("strips the frame from %s", (_name, input, expected) => {
    expect(copyableSelectionText(input)).toBe(expected);
  });

  it.each([
    ["table rows", "│ a │ b │\n│ c │ d │"],
    ["a framed table", "┌───┬───┐\n│ a │ b │\n└───┴───┘"],
    ["prose", "hello world"],
    ["a frame whose rows do not line up", "╭─ sh ───╮\n│ ls  │\n╰────────╯"],
  ])("leaves %s unchanged", (_name, input) => {
    expect(copyableSelectionText(input)).toBe(input);
  });
});
