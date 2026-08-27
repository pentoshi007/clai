import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { composerTopBorder } from "../../../src/classic/chrome/Composer.js";
import { composerFrame } from "../../../src/classic/chrome/composer-frame.js";
import { ComposerController } from "../../../src/classic/chrome/composer-controller.js";
import { plainText } from "../../../src/classic/render/ansi-text.js";
import { createInkTheme } from "../../../src/classic/render/ink-theme.js";
import { displayWidth } from "../../../src/classic/render/measure.js";
import { layoutEditor, renderEditor } from "../../../src/classic/chrome/editor-view.js";
import { CommandRegistry } from "../../../src/app/commands/registry.js";

const ink = createInkTheme({ themeHint: "dark", colorMode: "truecolor", unicode: true });

function frame(columns = 80) {
  return composerFrame({
    columns,
    allocatedRows: 3,
    text: "",
    mode: "agent",
    phase: "idle",
    unicode: true,
    metaLabel: "openai · gpt-test · default",
  });
}

function controller(servers: string[]) {
  const applied: string[] = [];
  const composer = new ComposerController({
    commands: new CommandRegistry(),
    clipboard: {},
    onSubmit: () => undefined,
    onToast: () => undefined,
    onScrollChat: () => undefined,
    onJumpTop: () => undefined,
    mcp: {
      serverNames: () => new Set(servers),
      applyMentionSelection: (text: string) => applied.push(text),
    },
  });
  return { composer, applied };
}

describe("classic composer MCP mentions", () => {
  it("keeps the top border free of MCP state", () => {
    const output = composerTopBorder(ink, frame());
    expect(plainText(output)).not.toContain("@mcp:");
    expect(displayWidth(output)).toBe(frame().width);
    const app = readFileSync("src/classic/app/ClassicApp.tsx", "utf8");
    expect(app).not.toContain("selectedMcpServer");
    expect(app).toContain("accentSpans={composer.mentionSpans}");
  });

  it("spans every mentioned live server in the draft and routes the selection", () => {
    const { composer, applied } = controller(["docs", "api"]);
    composer.setText("read @mcp:docs and @mcp:api and @mcp:ghost");
    const spans = composer.getSnapshot().mentionSpans;
    expect(spans).toHaveLength(2);
    expect(spans.every((span) => span.color === "aqua")).toBe(true);
    expect(applied.at(-1)).toBe("read @mcp:docs and @mcp:api and @mcp:ghost");

    const text = composer.getSnapshot().state.text;
    for (const span of spans) {
      expect(text.slice(span.start, span.end)).toMatch(/^@mcp:(docs|api)$/);
    }
  });

  it("drops the span and re-syncs once the token is deleted from the draft", () => {
    const { composer, applied } = controller(["docs"]);
    composer.setText("read @mcp:docs");
    expect(composer.getSnapshot().mentionSpans).toHaveLength(1);
    composer.setText("read ");
    expect(composer.getSnapshot().mentionSpans).toEqual([]);
    expect(applied.at(-1)).toBe("read ");
  });

  it("paints MCP tokens in aqua inside the input rows", () => {
    const { composer } = controller(["docs"]);
    composer.setText("@mcp:docs");
    const state = composer.getSnapshot().state;
    const rendered = renderEditor({
      state,
      layout: layoutEditor(state, 40),
      ink,
      height: 1,
      scrollTop: 0,
      showCaret: false,
      placeholder: undefined,
      accentSpans: composer.getSnapshot().mentionSpans,
    });
    expect(rendered.rows[0]).toContain(ink.style("@mcp:docs", { fg: "aqua", bold: true }));
  });
});
