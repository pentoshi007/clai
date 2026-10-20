import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import type { MouseEvent, Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { patchOpenTuiSelection } from "../../src/tui-v2/bootstrap/patch-opentui-selection.js";
import { startSnappedSelection } from "../../src/tui-v2/components/transcript/selection-snap.js";

patchOpenTuiSelection();

let setup: Awaited<ReturnType<typeof testRender>>;

function Fixture() {
  return h(
    "box",
    {
      style: { flexDirection: "column", width: "100%" },
      onMouseDown: (event: MouseEvent) => {
        startSnappedSelection<Renderable>(setup.renderer, event, [{ root: setup.renderer.root }]);
      },
    },
    h(
      "box",
      { style: { flexDirection: "column", paddingLeft: 2, paddingTop: 1, paddingBottom: 1 } },
      h("text", { selectable: true, content: "hello world", style: { height: 1 } }),
      h("text", { selectable: true, content: "second line", style: { height: 1 } }),
    ),
    h(
      "box",
      { style: { flexDirection: "column", paddingLeft: 2 } },
      h("text", { selectable: true, content: "third block", style: { height: 1 } }),
    ),
  );
}

async function drag(from: [number, number], to: [number, number]): Promise<string | null> {
  setup.renderer.clearSelection();
  await act(async () => {
    await setup.mockMouse.pressDown(from[0], from[1]);
    if (from[0] !== to[0] || from[1] !== to[1]) await setup.mockMouse.moveTo(to[0], to[1]);
    await setup.mockMouse.release(to[0], to[1]);
    await setup.flush();
  });
  return setup.renderer.getSelection()?.getSelectedText() ?? null;
}

setup = await testRender(h(Fixture), { width: 40, height: 10, useThread: false });
try {
  await act(async () => { await setup.flush(); });
  assert.equal(await drag([2, 1], [12, 1]), "hello world");
  assert.equal(await drag([2, 1], [6, 1]), "hello");
  assert.equal(await drag([12, 1], [2, 1]), "hello world");
  assert.equal(await drag([2, 1], [6, 2]), "hello world\nsecon");
  assert.equal(await drag([0, 1], [6, 1]), "hello");
  assert.equal(await drag([2, 3], [6, 4]), "third");
  assert.equal(await drag([0, 0], [39, 9]), "hello world\nsecond line\nthird block");
  assert.equal(await drag([5, 1], [5, 1]), null);
  assert.equal(setup.renderer.hasSelection, false);
} finally {
  await act(async () => { setup.renderer.destroy(); });
}
console.log("Native selection snapping passed");
