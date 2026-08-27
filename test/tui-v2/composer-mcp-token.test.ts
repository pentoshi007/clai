import { readFileSync } from "node:fs";
import { TextAttributes } from "@opentui/core";
import { describe, expect, it } from "vitest";
import { ComposerInputBox } from "../../src/tui-v2/components/composer/composer-input-box.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";

type ElementNode = {
  readonly props?: {
    readonly children?: unknown;
    readonly content?: string;
    readonly style?: Record<string, unknown>;
  };
};

const theme = themeFor("dark");

function render(selectedMcpServer?: string): ElementNode {
  return ComposerInputBox({
    theme,
    editorRef: { current: null },
    focused: true,
    running: false,
    width: 80,
    boxHeight: 3,
    metaShown: "",
    selectedMcpServer,
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

describe("OpenTUI composer MCP selection", () => {
  it("renders an explicitly selected server as a bold aqua token inside the input", () => {
    const token = children(render("docs")).find(
      (child) => child.props?.content === "@mcp:docs ",
    );
    expect(token).toBeDefined();
    expect(token?.props?.style).toMatchObject({
      fg: theme.aqua,
      attributes: TextAttributes.BOLD,
    });
  });

  it("renders no MCP token when no single server is selected", () => {
    expect(
      children(render()).some((child) => child.props?.content?.startsWith("@mcp:")),
    ).toBe(false);
  });

  it("derives the token only from server mode and keeps skills on activity color", () => {
    const app = readFileSync("src/tui-v2/app/App.tsx", "utf8");
    const editor = readFileSync("src/tui-v2/composer/composer-editor.tsx", "utf8");
    expect(app).toContain('mcpState.selection.mode === "server"');
    expect(app).toContain("selectedMcpServer={selectedMcpServer}");
    expect(editor).toContain("paintSkillMentions(editor, known, theme.activity)");
    expect(editor).toContain("sanitizeDisplayText(props.selectedMcpServer).slice(0, 32)");
  });
});
