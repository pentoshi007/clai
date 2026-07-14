// V2-013 — 10,000-row viewport-culling benchmark.
//
// Builds a ScrollBox with 10,000 text rows and viewport culling enabled, then
// renders and scrolls while measuring native frame time and cells updated.
// Culling is evidenced by cellsUpdated staying bounded to roughly the viewport
// (far below rows x width) rather than scaling with the full 10k content.
import { createTestRenderer } from "@opentui/core/testing";
import { ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { check, makeResult, measure, note, type SpikeResult } from "./harness.js";

const ROW_COUNT = 10_000;
const WIDTH = 80;
const HEIGHT = 24;
// OpenTUI native stats report frame time in microseconds.
const US_PER_MS = 1000;
// Steady-state scroll frames must stay smooth; the first render pays a one-time
// yoga layout cost for all 10k nodes, so it is reported but not budget-gated.
// The headline culling proof is cellsUpdated + far-row-not-rendered (checked
// below). This budget is a coarse smoke threshold that only catches pathological
// O(content) regressions; scroll-to-end triggers one heavier rebuild frame.
const SCROLL_FRAME_BUDGET_MS = 60;

export async function runViewportCullingSpike(): Promise<SpikeResult> {
  const result = makeResult("V2-013", "10,000-row viewport culling benchmark");
  const setup = await createTestRenderer({ width: WIDTH, height: HEIGHT, gatherStats: true });
  try {
    const scroll = new ScrollBoxRenderable(setup.renderer, {
      width: WIDTH,
      height: HEIGHT,
      viewportCulling: true,
      scrollY: true,
    });
    setup.renderer.root.add(scroll);

    const buildStart = performance.now();
    for (let i = 0; i < ROW_COUNT; i++) {
      const label = `Row ${String(i + 1).padStart(5, "0")} — selectable transcript line sentinel`;
      scroll.add(new TextRenderable(setup.renderer, { content: label }));
    }
    const buildMs = performance.now() - buildStart;

    await setup.renderOnce();
    const firstStats = setup.getNativeStats();
    const firstRenderMs = firstStats.nativeLastFrameTime / US_PER_MS;
    const firstFrame = setup.captureCharFrame();

    check(result, "all 10,000 rows attached", scroll.getChildren().length === ROW_COUNT,
      `children=${scroll.getChildren().length}`);
    check(result, "top row visible on first render", firstFrame.includes("Row 00001"));
    check(result, "far row NOT rendered initially (culling)", !firstFrame.includes("Row 09999"));

    // cellsUpdated should be bounded near the viewport, not the whole content.
    const fullContentCells = ROW_COUNT * WIDTH;
    const firstCells = firstStats.cellsUpdated ?? 0;
    check(result, "cellsUpdated bounded to viewport, not full content",
      firstCells > 0 && firstCells < fullContentCells / 10,
      `cellsUpdated=${firstCells} vs fullContent=${fullContentCells}`);

    // Steady-state scroll: measure frame time after the one-time first layout.
    const scrollFrameMs: number[] = [];

    scroll.scrollTo(scroll.scrollHeight / 2);
    await setup.renderOnce();
    scrollFrameMs.push(setup.getNativeStats().nativeLastFrameTime / US_PER_MS);
    const midFrame = setup.captureCharFrame();

    scroll.scrollTo(scroll.scrollHeight);
    await setup.renderOnce();
    scrollFrameMs.push(setup.getNativeStats().nativeLastFrameTime / US_PER_MS);
    const bottomFrame = setup.captureCharFrame();

    // A few incremental scrolls to sample typical scrolling cost.
    for (let i = 0; i < 10; i++) {
      scroll.scrollBy(-3);
      await setup.renderOnce();
      scrollFrameMs.push(setup.getNativeStats().nativeLastFrameTime / US_PER_MS);
    }

    check(result, "bottom row visible after scroll-to-end", bottomFrame.includes(`Row ${ROW_COUNT}`),
      `looking for Row ${ROW_COUNT}`);
    check(result, "top row culled after scrolling away", !bottomFrame.includes("Row 00001"));
    note(result, midFrame.length > 0 ? "mid-scroll frame non-empty" : "mid-scroll frame empty");

    const maxScroll = Math.max(...scrollFrameMs);
    const avgScroll = scrollFrameMs.reduce((a, b) => a + b, 0) / scrollFrameMs.length;
    check(result, `steady-state scroll frame within ${SCROLL_FRAME_BUDGET_MS}ms budget`,
      maxScroll < SCROLL_FRAME_BUDGET_MS, `maxScrollFrameMs=${maxScroll.toFixed(3)}`);

    const mem = process.memoryUsage();
    measure(result, "rowCount", ROW_COUNT);
    measure(result, "buildMs", Number(buildMs.toFixed(1)));
    measure(result, "firstRenderMs", Number(firstRenderMs.toFixed(2)));
    measure(result, "firstRenderCellsUpdated", firstCells);
    measure(result, "avgScrollFrameMs", Number(avgScroll.toFixed(3)));
    measure(result, "maxScrollFrameMs", Number(maxScroll.toFixed(3)));
    measure(result, "heapUsedMB", Number((mem.heapUsed / 1024 / 1024).toFixed(1)));
    measure(result, "rssMB", Number((mem.rss / 1024 / 1024).toFixed(1)));
    return result;
  } finally {
    setup.renderer.destroy();
  }
}
