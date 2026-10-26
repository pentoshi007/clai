import assert from "node:assert/strict";
import { act, createElement, createRef } from "react";
import { RGBA, type TextareaRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { paintDraftMentions } from "../../src/tui-v2/composer/composer-highlight.js";
import { setComposerCharacterOffset } from "../../src/tui-v2/composer/composer-cursor.js";
import { PasteRegistry, pastePlaceholderRanges } from "../../src/ui-core/composer/paste-placeholder.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";
import { formatAttachmentReference } from "../../src/ui/mentions.js";

const theme = themeFor("dark");

async function verifyChipColors(text: string, registry: PasteRegistry, width: number): Promise<number> {
  const ranges = pastePlaceholderRanges(text, registry.activeIn(text));
  assert.equal(ranges.length, text.split("[").length - 1);
  const cursors = [0, text.indexOf("["), text.indexOf("]"), text.length];
  const ref = createRef<TextareaRenderable>();
  const setup = await testRender(createElement("textarea", {
    ref, initialValue: text, focused: true, textColor: theme.foreground,
    cursorColor: theme.aqua, width, height: 8,
  }), { width, height: 8, useThread: false });
  try {
    for (const cursor of cursors) {
      await act(async () => {
        setComposerCharacterOffset(ref.current!, text, cursor, setup.renderer.widthMethod);
        paintDraftMentions({
          editor: ref.current, text, widthMethod: setup.renderer.widthMethod, skills: new Set(), servers: new Set(),
          skillColor: theme.activity, serverColor: theme.aqua, pasteColor: theme.aqua,
          pasteRanges: ranges,
        });
        await setup.flush();
      });
      const cells = setup.captureSpans().lines.flatMap((line) => line.spans.flatMap((span) =>
        [...span.text].map((char) => ({ char, fg: span.fg.toInts() })),
      ));
      let start = 0;
      for (const range of ranges.sort((a, b) => a.start - b.start)) {
        start = cells.findIndex((cell, index) => index >= start && cell.char === "[");
        assert.ok(start >= 0, setup.captureCharFrame());
        const end = cells.findIndex((cell, index) => index > start && cell.char === "]");
        const token = cells.slice(start, end + 1).filter((cell) => cell.char !== " ");
        assert.equal(token.map((cell) => cell.char).join(""), range.entry.token.replaceAll(" ", ""));
        for (const cell of token) {
          assert.deepEqual(cell.fg, RGBA.fromHex(theme.aqua).toInts(), `${JSON.stringify(text)} ${JSON.stringify(cell.char)} at width ${width}, cursor ${cursor}`);
        }
        start = end + 1;
      }
    }
    return cursors.length;
  } finally {
    await act(async () => setup.renderer.destroy());
    await setup.renderer.idle();
  }
}

let scenarios = 0;
for (const width of [100, 26]) {
  for (const prefix of ["", "\t ", "first\nnext ", "é ", "😀 ", "漢字 ", "👩🏽‍💻 é\nnext "]) {
    const registry = new PasteRegistry();
    const paste = registry.register("large prompt ".repeat(100));
    const image = registry.compactAttachments(formatAttachmentReference("screenshot.png"));
    for (const tokens of [image, paste.token, `${image} ${paste.token}`]) {
      scenarios += await verifyChipColors(`${prefix}${tokens}`, registry, width);
    }
  }
}
console.log(`Native composer chip colors passed: ${scenarios} whitespace, Unicode, wrapping and cursor scenarios`);
