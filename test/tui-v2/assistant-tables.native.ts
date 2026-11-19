import assert from "node:assert/strict";
import { act, createElement, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { AssistantMessage } from "../../src/tui-v2/components/transcript/assistant-message.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";
import { terminalWidth } from "../../src/ui-core/rendering/text-width.js";
import type { AssistantItem } from "../../src/ui-core/state/transcript-types.js";

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

function Harness() {
  const [state, setState] = useState(initial);
  update = setState;
  return createElement(AssistantMessage, { ...state, theme: themeFor("dark"), colorMode: "truecolor" });
}

const setup = await testRender(createElement(Harness), { width: 96, height: 22, useThread: false });
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
} finally {
  await act(async () => { setup.renderer.destroy(); });
  await setup.renderer.idle();
}
console.log("Native assistant tables passed");
