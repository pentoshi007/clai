import assert from "node:assert/strict";
import { act, createElement, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { useKeyboard, useRenderer } from "@opentui/react";
import type { MouseEvent, Renderable } from "@opentui/core";
import { startPaddedCellSelection } from "../../src/tui-v2/components/transcript/table-cell-selection.js";
import { startSnappedSelection } from "../../src/tui-v2/components/transcript/selection-snap.js";
import { chordFromKeyEvent } from "../../src/tui-v2/input/chord-from-opentui-key.js";
import { AssistantMessage } from "../../src/tui-v2/components/transcript/assistant-message.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";
import { terminalWidth } from "../../src/ui-core/rendering/text-width.js";
import type { AssistantItem } from "../../src/ui-core/state/transcript-types.js";

import { patchOpenTuiSelection } from "../../src/tui-v2/bootstrap/patch-opentui-selection.js";
import { useNativeSelectionCopy } from "../../src/tui-v2/components/transcript/use-native-selection-copy.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";

patchOpenTuiSelection();
const copies: string[] = [];
const services = createCompositionRoot({
  noHistory: true,
  clipboard: { async writeText(text) { copies.push(text); } },
  capabilities: detectCapabilities({ env: {}, stdoutIsTTY: true, stdinIsTTY: true, columns: 48, rows: 22 }),
});

const partial = [
  "| File | Result |",
  "| --- | --- |",
  "`sample.ts:12` | Completed |",
].join("\n");
const complete = partial + "\n| second | 👩🏽‍💻 Reviewed and ready for the next stage\n\nAdjacent prose";

const initial: { contentWidth: number; item: AssistantItem } = {
  contentWidth: 96,
  item: { id: "response", kind: "assistant", text: partial, streaming: true, sequence: 1, timestamp: 0, turnId: undefined },
};
let update = (_: typeof initial): void => { throw new Error("Assistant view has not mounted"); };

services.focus.focusRegion("transcript");

function Harness() {
  const handleKey = useNativeSelectionCopy(services);
  useKeyboard(key => { handleKey(key, chordFromKeyEvent(key)); });
  const [state, setState] = useState(initial);
  update = setState;
  const renderer = useRenderer();
  const onMouseDown = (event: MouseEvent) => {
    if (event.defaultPrevented || startPaddedCellSelection(renderer, event)) return;
    startSnappedSelection<Renderable>(renderer, event, [{ root: renderer.root }]);
  };
  return createElement("box", { onMouseDown }, createElement(AssistantMessage, { ...state, theme: themeFor("dark"), colorMode: "truecolor" }));
}

const setup = await testRender(createElement(Harness), { width: 96, height: 22, useThread: false, kittyKeyboard: true });
try {
  for (const width of [96, 48]) {
    for (const streaming of [true, false]) {
      const text = streaming ? partial : complete;
      await act(async () => {
        setup.resize(width, 22);
        update({ contentWidth: width, item: { ...initial.item, text, streaming } });
      });
      await act(async () => { await setup.flush(); });
      const frame = setup.captureCharFrame();
      const rows = frame.split("\n").map((line) => line.trimEnd());
      const top = rows.findIndex((row) => row.includes("┌"));
      const bottom = rows.findIndex((row) => row.includes("┘"));
      assert.ok(top >= 0 && bottom > top, frame);
      const table = rows.slice(top, bottom + 1);
      assert.ok(table.some((row) => /│ sample\.ts:12 +│ Completed +│/.test(row)), frame);
      if (!streaming) {
        assert.ok(table.some((row) => /│ second +│ 👩🏽‍💻/.test(row)), frame);
        assert.ok(rows.slice(bottom + 1).some((row) => row.includes("Adjacent prose")), frame);
      }
      assert.ok(table.every((row) => terminalWidth(row) === terminalWidth(table[0]!) && /[┐┤│┘]$/.test(row)), frame);
    }
  }
  const fixture = '| Left | Middle | Right |\n| --- | :---: | ---: |\n| before | alpha beta gamma delta epsilon zeta eta theta iota | after |\n| other | next row | neighbor |\n| empty | | side |';
  for (const streaming of [true, false]) {
    await act(async () => { update({ contentWidth: 48, item: { ...initial.item, text: fixture, streaming } }); });
    await act(async () => { await setup.flush(); });
    const rows = setup.captureCharFrame().split('\n');
    const first = rows.findIndex(row => row.includes('alpha'));
    const last = rows.findIndex(row => row.includes('iota'));
    assert.ok(first >= 0 && last > first, rows.join('\n'));
    const from = [rows[first]!.indexOf('beta'), first] as const;
    const to = [rows[last]!.indexOf('iota') + 1, last] as const;
    for (const [start, end] of [[from, to], [to, from]] as const) {
      copies.length = 0;
      await act(async () => {
        await setup.mockMouse.pressDown(...start);
        await setup.mockMouse.moveTo(...end);
        await setup.mockMouse.release(...end);
        await setup.flush();
      });
      assert.deepEqual(copies, ['beta gamma delta epsilon zeta eta theta io']);
      assert.doesNotMatch(setup.renderer.getSelection()!.getSelectedText(), /[│]|before|after|neighbor/);
    }
    await act(async () => { await setup.mockInput.pressKey("c", { ctrl: true, shift: true }); });
    assert.deepEqual(copies, Array(2).fill("beta gamma delta epsilon zeta eta theta io"));
    copies.length = 0;
    const neighbor = rows.findIndex(row => row.includes("neighbor"));
    await act(async () => {
      await setup.mockMouse.pressDown(...from);
      await setup.mockMouse.moveTo(46, neighbor);
      assert.deepEqual(copies, []);
      assert.doesNotMatch(setup.renderer.getSelection()!.getSelectedText(), /[│]|before|after|neighbor/);
      await setup.mockMouse.release(46, neighbor);
    });
    assert.deepEqual(copies, ["beta gamma delta epsilon zeta eta theta iota"]);
    const left = rows[first]!.lastIndexOf("│", from[0]);
    const right = rows[last]!.indexOf("│", to[0]);
    assert.ok(rows[first]!.indexOf("alpha") - left > 2);
    for (const [x, y, end, expected] of [
      [left + 1, first, to, "alpha beta gamma delta epsilon zeta eta theta io"],
      [right - 1, last, from, "beta gamma delta epsilon zeta eta theta iota"],
      [left, first, to, "alpha beta gamma delta epsilon zeta eta theta io"],
      [rows[last]!.indexOf("│") + 2, last, [rows[first]!.indexOf("before"), first], "before"],
    ] as const) {
      copies.length = 0;
      await act(async () => {
        await setup.mockMouse.pressDown(x, y);
        await setup.mockMouse.moveTo(...end);
        assert.doesNotMatch(setup.renderer.getSelection()!.getSelectedText(), /│/);
        await setup.mockMouse.release(...end);
      });
      assert.deepEqual(copies, [expected]);
    }
    copies.length = 0;
    const empty = rows.findIndex(row => row.includes("empty"));
    assert.ok(empty > last);
    await act(async () => {
      await setup.mockMouse.pressDown(left + 1, first);
      await setup.mockMouse.release(left + 1, first);
      await setup.mockMouse.pressDown(left + 1, empty);
      await setup.mockMouse.moveTo(...to);
      await setup.mockMouse.release(...to);
    });
    assert.deepEqual(copies, []);
    assert.equal(setup.renderer.hasSelection, false);
  }
} finally {
  await act(async () => { setup.renderer.destroy(); services.dispose(); });
  await setup.renderer.idle();
}
console.log("Native assistant tables passed");
