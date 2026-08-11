import { describe, expect, it } from "vitest";
import { blockContextFor } from "../../../src/classic/feed/feed-blocks.js";
import { buildToolLines } from "../../../src/classic/blocks/tool-lines.js";
import { displayWidth } from "../../../src/classic/render/measure.js";
import { transcriptItems } from "../../../src/ui-core/state/transcript-types.js";
import { feedView, scriptedTurn } from "./fixture.js";

describe("tool bg paint", () => {
  it("paints every row to full ctx width", () => {
    const turn = scriptedTurn();
    const ctx = blockContextFor(turn.state, feedView(turn, { columns: 80 }));
    const item = transcriptItems(turn.state).find((entry) => entry.kind === "tool");
    const lines = buildToolLines(ctx, item as never);
    for (const line of lines) {
      console.log(`[${displayWidth(line)}]${line.replaceAll("", "\\e")}`);
      expect(displayWidth(line)).toBe(80);
    }
  });
});
