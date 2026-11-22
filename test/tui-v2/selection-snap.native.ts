import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import type { MouseEvent, Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { patchOpenTuiSelection } from "../../src/tui-v2/bootstrap/patch-opentui-selection.js";
import { startSnappedSelection } from "../../src/tui-v2/components/transcript/selection-snap.js";
import { useNativeSelectionCopy } from "../../src/tui-v2/components/transcript/use-native-selection-copy.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";

patchOpenTuiSelection();

const copies: string[] = [];
const services = createCompositionRoot({
  noHistory: true,
  clipboard: { async writeText(text) { copies.push(text); } },
  capabilities: detectCapabilities({ env: {}, stdoutIsTTY: true, stdinIsTTY: true, columns: 40, rows: 10 }),
});
let setup: Awaited<ReturnType<typeof testRender>>;

function Fixture() {
  useNativeSelectionCopy(services);
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

async function assertReleaseCopy(
  from: [number, number],
  to: [number, number],
  lastDrag: [number, number] | undefined,
  expected: string,
): Promise<void> {
  copies.length = 0;
  await act(async () => {
    await setup.mockMouse.pressDown(...from);
    if (lastDrag) await setup.mockMouse.moveTo(...lastDrag);
    assert.deepEqual(copies, [], "nothing is copied until release");
    await setup.mockMouse.release(...to);
    await setup.mockMouse.release(...to);
    await setup.flush();
  });
  assert.deepEqual(copies, [expected], "copy uses the actual release coordinates exactly once");
  assert.equal(setup.renderer.getSelection()?.getSelectedText(), expected);
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
  assert.equal(await drag([0, 0], [0, 0]), null);
  assert.equal(setup.renderer.hasSelection, false);
  assert.deepEqual(copies, ["hello world", "hello", "hello world", "hello world\nsecon", "hello", "third", "hello world\nsecond line\nthird block"]);

  await assertReleaseCopy([2, 1], [6, 1], undefined, "hello");
  await assertReleaseCopy([2, 1], [6, 1], [3, 1], "hello");
  await assertReleaseCopy([2, 1], [39, 9], [6, 4], "hello world\nsecond line\nthird block");

  copies.length = 0;
  await act(async () => {
    await setup.mockMouse.pressDown(2, 1);
    await setup.mockMouse.moveTo(6, 1);
    setup.renderer.clearSelection();
    await setup.mockMouse.release(6, 1);
  });
  assert.deepEqual(copies, [], "cancelling an in-flight selection must not touch the clipboard");
} finally {
  await act(async () => { setup.renderer.destroy(); services.dispose(); });
}
console.log("Native selection snapping passed");
