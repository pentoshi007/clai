import { describe, expect, it } from "vitest";
import { RGBA } from "@opentui/core";
import { ComposerController } from "../../../src/classic/chrome/composer-controller.js";
import { layoutEditor, renderEditor } from "../../../src/classic/chrome/editor-view.js";
import { createInkTheme } from "../../../src/classic/render/ink-theme.js";
import { buildDefaultCommandRegistry } from "../../../src/app/commands/registry.js";
import { styleAnsiLine } from "../../../src/tui-v2/rendering/styled-markdown.js";

const ink = createInkTheme({ themeHint: "dark", colorMode: "truecolor", unicode: true });

describe("Classic attachment marker colors", () => {
  it("marks the entire folded paste aqua", () => {
    const composer = new ComposerController({
      commands: buildDefaultCommandRegistry(), clipboard: { async writeText() {} },
      onSubmit() {}, onToast() {},
    });
    composer.paste("prompt ".repeat(200));
    const snapshot = composer.getSnapshot();
    expect(snapshot.mentionSpans).toContainEqual({ start: 0, end: snapshot.state.text.length, color: "aqua" });
  });

  it.each([0, 7, 8, 9])("keeps highlighted brackets and the cursor character colored at %i", (cursor) => {
    const text = "[Image 1]";
    const state = { text, cursor };
    const rendered = renderEditor({
      state, layout: layoutEditor(state, 7), ink, height: 3, scrollTop: 0,
      showCaret: true, placeholder: undefined, accentSpans: [{ start: 0, end: text.length, color: "aqua" }],
    });
    const colored = rendered.rows.flatMap((row) => styleAnsiLine(row, ink.theme.foreground).chunks);
    for (const span of colored) {
      if (span.text.trim()) expect(span.fg?.toInts(), span.text).toEqual(RGBA.fromHex(ink.theme.aqua).toInts());
    }
  });
});
