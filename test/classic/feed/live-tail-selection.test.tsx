import { createElement } from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { LiveTail } from "../../../src/classic/feed/LiveTail.js";
import type { FeedBlock } from "../../../src/classic/feed/feed-blocks.js";
import { classicTranscriptDocument } from "../../../src/classic/feed/transcript-selection.js";
import { flattenBlocks, planTranscriptWindow } from "../../../src/classic/feed/transcript-window.js";

describe("LiveTail transcript selection", () => {
  it("renders selected text without changing visible row text", () => {
    const block: FeedBlock = {
      key: "0:a",
      itemId: "a",
      kind: "assistant",
      open: false,
      lines: ["alpha bravo"],
      turnId: undefined,
      sequence: 0,
    };
    const window = planTranscriptWindow(flattenBlocks([block]), 1, 0);
    const document = classicTranscriptDocument([block]);
    const selection = {
      activePane: "transcript" as const,
      range: {
        pane: "transcript" as const,
        anchor: { blockId: "0:a", offset: 1 },
        focus: { blockId: "0:a", offset: 5 },
      },
      dragging: false,
      autoscrollPane: undefined,
    };
    const frame = renderToString(createElement(LiveTail, { window, rows: 1, document, selection }));
    expect(frame.replace(/\u001b\[[0-9;]*m/g, "")).toBe("alpha bravo");
    expect(frame).toBe("alpha bravo");
  });
});
