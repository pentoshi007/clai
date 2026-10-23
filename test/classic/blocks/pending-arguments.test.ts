import { expect, it } from "vitest";
import { buildToolLines } from "../../../src/classic/blocks/tool-lines.js";
import { blockContextFor, buildFeedBlocks, FeedBlockCache } from "../../../src/classic/feed/feed-blocks.js";
import { stripAnsi } from "../../../src/classic/render/measure.js";
import { transcriptItems, type ToolItem } from "../../../src/ui-core/state/transcript-types.js";
import { feedView, scriptedTurn } from "../feed/fixture.js";

const turn = scriptedTurn();
const tool = transcriptItems(turn.state).find((item): item is ToolItem => item.kind === "tool")!;
const pending: ToolItem = { ...tool, status: "queued", pending: true, argsDisplay: '{"partial":"do-not-render' };

it.each([
  [-500, "."], [0, "."], [999, "."], [1000, ".."],
  [1999, ".."], [2000, "..."], [3000, "."], [9000, "."],
] as const)("renders the pending animation at %ims", (elapsed, dots) => {
  const ctx = blockContextFor(turn.state, { ...feedView(turn, { columns: 40 }), now: pending.timestamp + elapsed });
  const text = buildToolLines(ctx, pending).map(stripAnsi).join("\n");
  expect(text).toContain(`receiving arguments ${dots}`);
  expect(text.match(/receiving arguments (\.+)/)?.[1]).toBe(dots);
  expect(text).not.toContain("do-not-render");
});

it("advances cached pending rows without changing card identity or settled rows", () => {
  const state = { ...turn.state, byId: new Map(turn.state.byId).set(pending.id, pending) };
  const cache = new FeedBlockCache();
  const view = feedView(turn, { columns: 80 });
  const settled = turn.state.order.find(id => id !== pending.id && turn.state.byId.get(id)?.kind === "user")!;
  let previousSettled: ReturnType<typeof buildFeedBlocks>[number] | undefined;
  for (const [elapsed, dots] of [[0, "."], [1000, ".."], [2000, "..."], [3000, "."]] as const) {
    const blocks = buildFeedBlocks(state, { ...view, now: pending.timestamp + elapsed }, cache);
    const block = blocks.find(entry => entry.itemId === pending.id)!;
    expect(block.lines.map(stripAnsi).join("\n").match(/receiving arguments (\.+)/)?.[1]).toBe(dots);
    expect(block.key).toBe(`0:${pending.id}`);
    const settledBlock = blocks.find(entry => entry.itemId === settled)!;
    if (previousSettled) expect(settledBlock).toBe(previousSettled);
    previousSettled = settledBlock;
  }
});
