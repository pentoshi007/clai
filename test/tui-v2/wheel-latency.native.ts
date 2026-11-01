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
let animationFrames = 0;

function wheelReports(count: number, direction: "up" | "down"): string {
  const viewport = findScrollBox(setup.renderer.root)!.viewport;
  const button = direction === "up" ? 64 : 65;
  return `\x1b[<${button};${viewport.x + 3};${viewport.y + 2}M`.repeat(count);
}

async function deliver(input: string): Promise<void> {
  await act(async () => {
    setup.renderer.stdin.emit("data", Buffer.from(input));
    await Promise.resolve();
  });
}

async function paint(): Promise<string> {
  await act(async () => { await setup.renderOnce(); });
  return setup.captureCharFrame();
}

try {
  await act(async () => { await setup.waitForFrame((view) => view.includes("ROW_599")); });
  const sb = findScrollBox(setup.renderer.root)!;
  const order = services.transcript.getState().order;
  await deliver(wheelReports(1, "up"));
  await paint();
  globalThis.requestAnimationFrame = (callback) => {
    animationFrames += 1;
    return requestFrame(callback);
  };
  setRenderCountersEnabled(true);
  resetRenderCounts();

  const glide = async (): Promise<number[]> => {
    const steps: number[] = [];
    for (let frame = 0; frame < 240; frame += 1) {
      const before = sb.scrollTop;
      await paint();
      if (sb.scrollTop === before) break;
      steps.push(sb.scrollTop - before);
    }
    return steps;
  };

  const start = sb.scrollTop;
  await deliver(wheelReports(120, "up"));
  const burst = await glide();
  assert.equal(sb.scrollTop, start - 120, "a burst travels exactly its wheel distance");
  assert.ok(burst.length > 1, "a burst glides across frames instead of jumping in one");
  assert.ok(burst.every((rows) => rows < 0), "the glide never moves against the wheel");
  assert.ok(-burst[0]! < 120, "the first frame starts the glide without dumping the burst");
  assert.equal(animationFrames, 0, "wheel input never schedules animation frames");
  assert.equal(readRenderCounts().get("TranscriptRow") ?? 0, 0, "scrolling reuses unchanged transcript rows");

  for (let notch = 0; notch < 5; notch += 1) {
    const before = sb.scrollTop;
    await deliver(wheelReports(1, "up"));
    await paint();
    assert.equal(sb.scrollTop, before - 1, "each isolated notch moves exactly one row on the next frame");
    assert.deepEqual(await glide(), [], "an isolated notch leaves no trailing motion");
  }

  const glideStart = sb.scrollTop;
  await deliver(wheelReports(30, "up"));
  await paint();
  const reversedAt = sb.scrollTop;
  assert.ok(reversedAt < glideStart && reversedAt > glideStart - 30, "the reversal interrupts a glide in progress");
  await deliver(wheelReports(1, "down"));
  await paint();
  assert.equal(sb.scrollTop, reversedAt + 1, "a reversal responds on the next frame");
  assert.deepEqual(await glide(), [], "a reversal drops the unfinished glide");

  await act(async () => {
    transcriptScrollPort.wheel(-120);
    transcriptScrollPort.scrollToBottom();
  });
  await paint();
  await paint();
  assert.equal(sb.scrollTop, sb.scrollHeight - sb.viewport.height, "jump-to-latest discards pending wheel input");
  assert.equal(services.transcript.getState().order, order);
  assert.equal(order.length, 1);
  console.log(`Native wheel latency passed: glide_frames=${burst.length} animation_frames=0 row_rerenders=0`);
} finally {
  transcriptScrollPort.stopWheel();
  setRenderCountersEnabled(false);
  globalThis.requestAnimationFrame = requestFrame;
  await act(async () => { services.dispose(); setup.renderer.destroy(); });
  await setup.renderer.idle();
}
