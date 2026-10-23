import assert from "node:assert/strict";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { ScrollBoxRenderable, type Renderable } from "@opentui/core";
import { App } from "../../src/tui-v2/app/App.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { transcriptScrollPort } from "../../src/tui-v2/components/transcript/transcript-scroll-port.js";
import { EventSequencer, createCountingIdFactory } from "../../src/app/events/sequencer.js";
import { asMessageId, asSessionId, asTurnId } from "../../src/app/events/app-event.js";
import { readRenderCounts, resetRenderCounts, setRenderCountersEnabled } from "../../src/tui-v2/perf/render-counters.js";

function findScrollBox(node: Renderable): ScrollBoxRenderable | undefined {
  if (node instanceof ScrollBoxRenderable) return node;
  for (const child of node.getChildren()) {
    const found = findScrollBox(child);
    if (found) return found;
  }
  return undefined;
}

const services = createCompositionRoot({
  noHistory: true,
  persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: 90, rows: 30 }),
});
const seq = new EventSequencer(asSessionId("wheel-latency"), createCountingIdFactory("wheel"));
services.transcript.dispatch(seq.build("assistant-message", {
  messageId: asMessageId("long-message"),
  text: Array.from({ length: 600 }, (_, row) => `ROW_${String(row).padStart(3, "0")} scroll proof`).join("\n"),
}, asTurnId("wheel-turn")));
const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), {
  width: 90, height: 30, useThread: false, useMouse: true,
});
const requestFrame = globalThis.requestAnimationFrame;
const cancelFrame = globalThis.cancelAnimationFrame;
const performanceNow = performance.now;
const queued = new Map<number, FrameRequestCallback>();
let frameId = -100;
let now = 0;

async function frame(elapsedMs: number): Promise<void> {
  now += elapsedMs;
  const callbacks = [...queued.values()];
  queued.clear();
  await act(async () => {
    for (const callback of callbacks) callback(elapsedMs);
    await setup.renderOnce();
  });
  await act(async () => { await setup.renderOnce(); });
}

async function burst(count: number, direction: "up" | "down"): Promise<void> {
  const viewport = findScrollBox(setup.renderer.root)!.viewport;
  await act(async () => {
    for (let index = 0; index < count; index += 1) {
      await setup.mockMouse.scroll(viewport.x + 2, viewport.y + 1, direction);
    }
  });
}

try {
  await act(async () => { await setup.waitForFrame((view) => view.includes("ROW_599")); });
  const sb = findScrollBox(setup.renderer.root)!;
  const order = services.transcript.getState().order;
  globalThis.requestAnimationFrame = (callback) => {
    const id = --frameId;
    queued.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    if (id < 0) queued.delete(id);
    else cancelFrame(id);
  };
  performance.now = () => now;

  await burst(1, "up");
  await frame(17);
  setRenderCountersEnabled(true);
  resetRenderCounts();
  const start = sb.scrollTop;
  const views: string[] = [];
  const deltas: number[] = [];
  await burst(120, "up");
  assert.equal(queued.size, 1, "dense input coalesces into one pending frame");
  let previous = start;
  for (let index = 0; index < 3; index += 1) {
    await frame(17);
    deltas.push(previous - sb.scrollTop);
    previous = sb.scrollTop;
    views.push(setup.captureCharFrame());
  }
  assert.equal(sb.scrollTop, start - 120, "native wheel input preserves every row within 51ms");
  assert.deepEqual(deltas, [41, 41, 38], "a buffered burst remains continuous across frames");
  assert.equal(new Set(views).size, 3, "each native frame actually paints the intermediate position");
  assert.equal(queued.size, 0, "no trailing wheel animation remains");
  assert.equal(readRenderCounts().get("TranscriptRow") ?? 0, 0, "scrolling reuses unchanged transcript rows");

  await burst(120, "down");
  await frame(100);
  assert.equal(sb.scrollTop, start, "a delayed frame catches up instead of replaying stale events");
  assert.equal(queued.size, 0);
  await burst(120, "up");
  await frame(17);
  const reversedAt = sb.scrollTop;
  await burst(1, "down");
  await frame(17);
  assert.equal(sb.scrollTop, reversedAt + 1, "a reversal responds on the next painted frame");
  assert.equal(queued.size, 0);

  await burst(120, "up");
  await act(async () => { transcriptScrollPort.scrollToBottom(); });
  await frame(100);
  assert.equal(sb.scrollTop, sb.scrollHeight - sb.viewport.height, "jump-to-latest cancels stale motion");
  assert.equal(services.transcript.getState().order, order);
  assert.equal(order.length, 1);
  console.log(`Native wheel latency passed: burst_ms=51 frames=3 row_rerenders=0 steps=${deltas.join(",")}`);
} finally {
  transcriptScrollPort.stopWheel();
  setRenderCountersEnabled(false);
  performance.now = performanceNow;
  globalThis.requestAnimationFrame = requestFrame;
  globalThis.cancelAnimationFrame = cancelFrame;
  await act(async () => { services.dispose(); setup.renderer.destroy(); });
  await setup.renderer.idle();
}
