import assert from "node:assert/strict";
import { act, createElement, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { RGBA, TextAttributes, TextRenderable } from "@opentui/core";
import type { ColorMode } from "../../src/app/ports/terminal-port.js";
import { ThinkingBlock } from "../../src/tui-v2/components/transcript/thinking-block.js";
import { TerminalDimensionsContext } from "../../src/tui-v2/hooks/terminal-dimensions.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";
import type { ThinkingItem } from "../../src/ui-core/state/transcript-types.js";

interface View {
  item: ThinkingItem;
  width: number;
  expanded: boolean;
  focused: boolean;
  theme: "dark" | "light";
  colorMode: ColorMode;
}

let view: View = {
  item: { id: "reasoning-markdown", sequence: 1, timestamp: 0, turnId: undefined, kind: "thinking", content: "", streaming: true },
  width: 80,
  expanded: false,
  focused: true,
  theme: "dark",
  colorMode: "truecolor",
};
let updateView: (next: View) => void = () => { throw new Error("Reasoning view has not mounted"); };

function Harness() {
  const [state, setState] = useState(view);
  updateView = setState;
  return createElement(TerminalDimensionsContext.Provider, {
    value: { width: state.width, height: 32 },
    children: createElement(ThinkingBlock, {
      item: state.item,
      theme: themeFor(state.theme),
      colorMode: state.colorMode,
      contentWidth: state.width,
      expanded: state.expanded,
      focused: state.focused,
      onToggle: () => {
        view = { ...view, expanded: !view.expanded };
        updateView(view);
      },
    }),
  });
}

const setup = await testRender(createElement(Harness), { width: 80, height: 32, useThread: false });

async function settle(action: () => unknown = () => undefined): Promise<string> {
  await act(async () => { await action(); });
  await act(async () => { await setup.flush(); });
  return setup.captureCharFrame();
}

async function render(next: Partial<View>, content?: string): Promise<string> {
  view = { ...view, ...next };
  if (content !== undefined) view = { ...view, item: { ...view.item, content } };
  return settle(() => {
    updateView(view);
    setup.resize(view.width, 32);
  });
}

function assertStyle(text: string, attribute: number): void {
  const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
  const span = spans.find((candidate) => candidate.text.includes(text));
  assert.ok(span, `Missing styled text ${text}: ${setup.captureCharFrame()}`);
  assert.ok(span.attributes & attribute, `Missing attribute ${attribute} for ${text}: ${span.attributes}`);
}

function assertPlainColor(): void {
  const theme = themeFor(view.theme);
  const expected = RGBA.fromHex(view.focused ? theme.thinking : theme.thinkingDim).toInts();
  const span = setup.captureSpans().lines.flatMap((line) => line.spans).find((candidate) => candidate.text.includes("plain"));
  assert.ok(span, setup.captureCharFrame());
  assert.deepEqual(span.fg.toInts(), expected);
}

try {
  await settle();
  let content = "";
  for (const chunk of ["plain **BO", "LD** and *ita", "lic* with `co", "de` and ~~removed~~"]) {
    content += chunk;
    await render({}, content);
  }
  assertStyle("BOLD", TextAttributes.BOLD);
  assertStyle("italic", TextAttributes.ITALIC);
  assertStyle("removed", TextAttributes.STRIKETHROUGH);
  assert.ok(!setup.captureCharFrame().includes("**"));
  assertPlainColor();

  for (const theme of ["dark", "light"] as const) {
    for (const colorMode of ["truecolor", "256", "16", "none"] as const) {
      for (const width of [40, 80, 120]) {
        for (const streaming of [true, false]) {
          await render({ theme, colorMode, width, expanded: true, item: { ...view.item, streaming } });
          const frame = setup.captureCharFrame();
          assert.ok(frame.includes("BOLD"), frame);
          assert.ok(frame.includes("italic"), frame);
          assert.ok(!frame.includes("**"), frame);
          if (colorMode !== "none") assertStyle("BOLD", TextAttributes.BOLD);
          assertPlainColor();
          const card = setup.renderer.root.findDescendantById(view.item.id);
          assert.ok(card);
          assert.ok(card.x >= 0 && card.x + card.width <= width);
          assert.ok(card.getChildren().every((child) => !(child instanceof TextRenderable) || child.x + child.width <= card.x + card.width - 1));
        }
      }
    }
  }

  await render({ theme: "dark", colorMode: "truecolor", width: 80, focused: false });
  assertPlainColor();
  await render({ focused: true });
  assertPlainColor();

  for (const streaming of [true, false]) {
    await render({ width: 120, expanded: true, item: { ...view.item, streaming } }, "opening **FIRST_TITLE** FIRST_BODY **SECOND_TITLE** SECOND_BODY");
    const frame = setup.captureCharFrame();
    for (const title of ["FIRST_TITLE", "SECOND_TITLE"]) {
      const row = frame.split("\n").find((line) => line.includes(title));
      assert.ok(row, frame);
      assert.ok(!/opening|FIRST_BODY|SECOND_BODY/.test(row), `Reasoning title shares a row with prose: ${row}`);
      assertStyle(title, TextAttributes.BOLD);
    }
    assert.ok(frame.includes("FIRST_BODY") && frame.includes("SECOND_BODY"), frame);
  }

  for (const streaming of [true, false]) {
    await render({ width: 40, item: { ...view.item, streaming } }, `**${"日本語 🧪 long thought ".repeat(30)}**`);
    assert.ok(!setup.captureCharFrame().includes("**"));
    assertStyle("日本語", TextAttributes.BOLD);
  }

  await render({ width: 80, item: { ...view.item, streaming: true } }, "```text\n**literal**\n```");
  assert.ok(setup.captureCharFrame().includes("**literal**"));
  assert.ok(!setup.captureCharFrame().includes("```text"));

  const rows = Array.from({ length: 40 }, (_, index) => `**ROW_${index.toString().padStart(2, "0")}**`);
  await render({}, rows.join("\n"));
  assert.ok(setup.captureCharFrame().includes("ROW_39"));
  assert.ok(!setup.captureCharFrame().includes("ROW_00"));
  assertStyle("ROW_39", TextAttributes.BOLD);
  const card = setup.renderer.root.findDescendantById(view.item.id)!;
  await settle(() => setup.mockMouse.scroll(card.x + 3, card.y + 2, "up"));
  const scrolled = setup.captureCharFrame();
  assert.ok(scrolled.includes("ROW_17"), scrolled);
  assert.ok(!scrolled.includes("ROW_39"), scrolled);
  rows.push("**ROW_40**");
  await render({}, rows.join("\n"));
  assert.ok(setup.captureCharFrame().includes("ROW_17"));
  assert.ok(!setup.captureCharFrame().includes("ROW_40"));
  await render({ item: { ...view.item, streaming: false }, expanded: true });
  assert.ok(setup.captureCharFrame().includes("ROW_00"));
  assertStyle("ROW_00", TextAttributes.BOLD);
  await render({ expanded: false });
  assert.ok(!setup.captureCharFrame().includes("ROW_00"));
  assert.ok(setup.captureCharFrame().includes("click or Ctrl+T to view"));
  await render({ expanded: true });
  assertStyle("ROW_00", TextAttributes.BOLD);
} finally {
  await act(async () => { setup.renderer.destroy(); });
  await setup.renderer.idle();
}

console.log("Native reasoning Markdown passed: streamed and completed styles, themes, widths, scrolling and disclosure");
