import { describe, expect, it } from "vitest";
import { asToolCallId } from "../../../src/app/events/app-event.js";
import { buildToolLines } from "../../../src/classic/blocks/tool-lines.js";
import { buildDiffLines } from "../../../src/classic/blocks/diff-lines.js";
import { buildBatchLines } from "../../../src/classic/blocks/batch-lines.js";
import { FeedBlockCache, buildFeedBlocks } from "../../../src/classic/feed/feed-blocks.js";
import { createInkTheme } from "../../../src/classic/render/ink-theme.js";
import { displayWidth, stripAnsi } from "../../../src/classic/render/measure.js";
import { EMPTY_TRANSCRIPT_STATE, type ToolItem } from "../../../src/ui-core/state/transcript-types.js";
import { EMPTY_SPOOL, type BlockContext } from "../../../src/classic/blocks/block-context.js";
import { hasAnimatedTools, TOOL_BALL_INTERVAL_MS } from "../../../src/ui-core/rendering/tool-status-ball.js";

const tool: ToolItem = {
  id: "ball-tool", sequence: 1, turnId: undefined, timestamp: 0, kind: "tool", toolCallId: asToolCallId("ball-call"),
  name: "shell.exec", argsDisplay: "printf ready", status: "queued", exitCode: undefined, summary: undefined,
  artifactPath: undefined, reason: undefined, outputBytes: 0, fileChanges: undefined,
};
const ink = createInkTheme({ themeHint: "dark", colorMode: "truecolor", unicode: true });
const ctx: BlockContext = { width: 80, ink, glyphs: ink.glyphs, now: 0, state: EMPTY_TRANSCRIPT_STATE, spool: EMPTY_SPOOL, markdownCache: undefined };

it.each(["queued", "running"] as const)("rotates %s in the cached classic feed without adding rows", (status) => {
  const item = { ...tool, status, pending: status === "queued" };
  const state = { ...EMPTY_TRANSCRIPT_STATE, order: [tool.id], byId: new Map([[tool.id, item]]) };
  const cache = new FeedBlockCache();
  const view = { columns: 80, ink, now: 0, generation: 0 };
  const first = buildFeedBlocks(state, view, cache)[0]!;
  const firstLines = [...first.lines];
  const second = buildFeedBlocks(state, { ...view, now: TOOL_BALL_INTERVAL_MS }, cache)[0]!;
  expect(second.lines).not.toEqual(firstLines);
  expect(stripAnsi(second.lines[0]!)).toMatch(/^● Shell/u);
  expect(second.lines.slice(1).map(stripAnsi)).toEqual(firstLines.slice(1).map(stripAnsi));
  expect(second.lines.length).toBe(firstLines.length);
  expect(hasAnimatedTools(state)).toBe(true);
});

it.each(["ok", "failed", "blocked"] as const)("keeps %s static and reuses its cached classic block", (status) => {
  const item = { ...tool, status };
  const state = { ...EMPTY_TRANSCRIPT_STATE, order: [tool.id], byId: new Map([[tool.id, item]]) };
  const cache = new FeedBlockCache();
  const view = { columns: 80, ink, now: 0, generation: 0 };
  const first = buildFeedBlocks(state, view, cache)[0]!;
  expect(buildFeedBlocks(state, { ...view, now: TOOL_BALL_INTERVAL_MS }, cache)[0]).toBe(first);
  expect(hasAnimatedTools(state)).toBe(false);
});

describe.each([40, 80, 120])("classic ball headings at %s columns", (width) => {
  it("keeps ordinary, diff and batch headings in one row", () => {
    const context = { ...ctx, width };
    const batch = { ...tool, name: "tool.batch", status: "running" as const };
    const spool = { ...EMPTY_SPOOL, tail: () => "── #1 shell.exec [running]\nready" };
    const cases = [buildToolLines(context, tool), buildDiffLines(context, tool), buildBatchLines({ ...context, spool }, batch)];
    for (const lines of cases) {
      expect(stripAnsi(lines[0]!)).toMatch(/^● /u);
      expect(stripAnsi(lines.join("\n"))).not.toMatch(/[▄▀\u{10eeee}]/u);
      for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(width);
    }
    const [heading, next] = buildToolLines(context, tool);
    expect(stripAnsi(heading!).match(/●/gu)).toHaveLength(1);
    expect(stripAnsi(next!)).not.toMatch(/●/u);
  });

  it("sits the ball directly against the tool name", () => {
    const [heading] = buildToolLines({ ...ctx, width }, tool);
    expect(stripAnsi(heading!)).toMatch(/^● Shell printf ready/u);
  });
});
