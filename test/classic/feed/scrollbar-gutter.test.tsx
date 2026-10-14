import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScrollbarGutter } from "../../../src/classic/feed/ScrollbarGutter.js";
import type { FeedBlock } from "../../../src/classic/feed/feed-blocks.js";
import { scrollbarCell, scrollbarGeometry } from "../../../src/classic/feed/scrollbar-rows.js";
import { planTranscriptWindow } from "../../../src/classic/feed/transcript-window.js";
import { createInkTheme } from "../../../src/classic/render/ink-theme.js";

const ink = createInkTheme({ themeHint: "dark", colorMode: "none", unicode: true });
const blocks: readonly FeedBlock[] = [{
  key: "0:a", itemId: "a", kind: "assistant", open: false,
  lines: Array.from({ length: 100 }, (_, index) => `row ${index}`),
  turnId: undefined, sequence: 0,
}];

afterEach(() => vi.useRealTimers());

describe("classic scrollbar rendering", () => {
  it("preserves the full track, thumb position, and top padding", async () => {
    const ui = render(<ScrollbarGutter ink={ink} window={planTranscriptWindow(blocks, 10, 0)} rows={10} offsetTop={2} />);
    try {
      expect(ui.lastFrame()).not.toContain("█");
      ui.rerender(<ScrollbarGutter ink={ink} window={planTranscriptWindow(blocks, 10, 30)} rows={10} offsetTop={2} />);
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("█"));
      const visible = ui.lastFrame()!.split("\n").map((line) => line.trim());
      expect(visible).toEqual(["", "", ...scrollbarGeometry(10, 100, 30).map(scrollbarCell)]);
    } finally {
      ui.unmount();
      ui.cleanup();
    }
  });

  it("extends visibility on another scroll, hides after inactivity, and hides at the bottom", async () => {
    vi.useFakeTimers();
    const view = (offset: number) => <ScrollbarGutter ink={ink} window={planTranscriptWindow(blocks, 10, offset)} rows={10} offsetTop={0} />;
    const ui = render(view(0));
    try {
      ui.rerender(view(10));
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("█"));
      await vi.advanceTimersByTimeAsync(700);
      ui.rerender(view(20));
      await vi.advanceTimersByTimeAsync(500);
      expect(ui.lastFrame()).toContain("█");
      await vi.advanceTimersByTimeAsync(600);
      await vi.waitFor(() => expect(ui.lastFrame()).not.toContain("█"));
      ui.rerender(view(30));
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("█"));
      ui.rerender(view(0));
      await vi.waitFor(() => expect(ui.lastFrame()).not.toContain("█"));
    } finally {
      ui.unmount();
      ui.cleanup();
    }
  });
});
