import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ComposerInputBox } from "../../src/tui-v2/components/composer/composer-input-box.js";
import { findMcpMentions, formatMcpToken } from "../../src/mcp/mentions.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";

type ElementNode = {
  readonly props?: {
    readonly children?: unknown;
    readonly content?: string;
    readonly style?: Record<string, unknown>;
  };
};

const theme = themeFor("dark");

function render(): ElementNode {
  return ComposerInputBox({
    theme,
    editorRef: { current: null },
    focused: true,
    running: false,
    width: 80,
    boxHeight: 3,
    metaShown: "",
    chromeFg: theme.inputBorder,
    keyBindings: undefined as never,
    onMouseDown: () => undefined,
    onMouseScroll: () => undefined,
    onSubmit: () => undefined,
    onContentChange: () => undefined,
    onCursorChange: () => undefined,
    onKeyDown: () => undefined,
  }) as ElementNode;
}

function children(node: ElementNode): ElementNode[] {
  const value = node.props?.children;
  return (Array.isArray(value) ? value : [value]).filter(
    (child): child is ElementNode =>
      child !== null && typeof child === "object" && "props" in child,
  );
}

describe("OpenTUI composer MCP mentions", () => {
  it("highlights a namespaced server name in full so it is not left as plain text", () => {
    const name = "io.github.github/github-mcp-server";
    const known = new Set([name, "notion"]);
    const text = `${formatMcpToken(name)} list my repos`;
    const found = findMcpMentions(text, known);
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe(name);
    expect(text.slice(found[0]!.start, found[0]!.end)).toBe(formatMcpToken(name));
  });

  it("highlights namespaced and plain servers side by side", () => {
    const namespaced = "io.github.github/github-mcp-server";
    const known = new Set([namespaced, "notion"]);
    const text = `try ${formatMcpToken(namespaced)} and ${formatMcpToken("notion")} now`;
    const found = findMcpMentions(text, known);
    expect(found.map((mention) => mention.name)).toEqual([namespaced, "notion"]);
    for (const mention of found) {
      expect(text.slice(mention.start, mention.end)).toBe(formatMcpToken(mention.name));
    }
  });

  it("trims trailing punctuation after a namespaced server name", () => {
    const name = "io.github.github/github-mcp-server";
    const known = new Set([name]);
    const text = `${formatMcpToken(name)}, then stop`;
    const found = findMcpMentions(text, known);
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe(name);
  });

  it("still ignores a namespaced name that is not a live server", () => {
    expect(findMcpMentions("@mcp:unknown/server nope", new Set(["notion"]))).toEqual([]);
  });

  it("keeps MCP out of the input chrome so the token lives in the editable draft", () => {
    expect(
      children(render()).some((child) => child.props?.content?.startsWith("@mcp:")),
    ).toBe(false);
  });

  it("resolves and highlights every live server mentioned in the draft", () => {
    const known = new Set(["docs", "api"]);
    const text = `read ${formatMcpToken("docs")} and ${formatMcpToken("api")} but not @mcp:ghost`;
    const ranges = findMcpMentions(text, known);
    expect(ranges.map((range) => range.name)).toEqual(["docs", "api"]);
    for (const range of ranges) {
      expect(text.slice(range.start, range.end)).toBe(formatMcpToken(range.name));
    }
    expect(findMcpMentions("read @mcp:docs, then stop", known)[0]?.name).toBe("docs");
  });

  it("paints skill and MCP mentions from the draft and syncs the selection", () => {
    const editor = readFileSync("src/tui-v2/composer/composer-editor.tsx", "utf8");
    expect(editor).toContain("paintDraftMentions(");
    expect(editor).toContain("skillColor: theme.activity");
    expect(editor).toContain("serverColor: theme.aqua");
    expect(editor).toContain("services.mcp.applyMentionSelection(text)");
    expect(editor).not.toContain("selectedMcpServer");
    expect(readFileSync("src/tui-v2/app/App.tsx", "utf8")).not.toContain("selectedMcpServer");
  });
});
