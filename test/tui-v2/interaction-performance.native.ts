import assert from "node:assert/strict";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { ScrollBoxRenderable, type Renderable } from "@opentui/core";
import { setTimeout as delay } from "node:timers/promises";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { App } from "../../src/tui-v2/app/App.js";
import { OPEN_TUI_FRAME_PACING } from "../../src/tui-v2/bootstrap/frame-pacing.js";
import { EventSequencer } from "../../src/app/events/sequencer.js";
import { asTurnId } from "../../src/app/events/app-event.js";
import { EMPTY_TRANSCRIPT_STATE, type UserItem } from "../../src/ui-core/state/transcript-types.js";
import { transcriptScrollPort } from "../../src/tui-v2/components/transcript/transcript-scroll-port.js";
import { readRenderCounts, resetRenderCounts, setRenderCountersEnabled } from "../../src/tui-v2/perf/render-counters.js";

const services = createCompositionRoot({
  noHistory: true,
  provider: "openai",
  model: "offline-test",
  agent: { async runTurn() { return "offline"; } },
  persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  updates: { async check() { return { state: "current", currentVersion: "test", updateAvailable: false }; } },
  capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: 100, rows: 32 }),
});
const items: UserItem[] = Array.from({ length: 240 }, (_, index) => ({
  id: `perf-user-${index}`, kind: "user", text: `HISTORY_${index} full retained prompt with 日本語 and 🧪`, sequence: index + 1, timestamp: 0, turnId: undefined,
}));
services.transcript.hydrate({ ...EMPTY_TRANSCRIPT_STATE, order: items.map((item) => item.id), byId: new Map(items.map((item) => [item.id, item])) });
let subscriptions = 0;
let unsubscriptions = 0;
const originalSubscribe = services.transcript.subscribe.bind(services.transcript);
services.transcript.subscribe = (listener) => {
  subscriptions += 1;
  const unsubscribe = originalSubscribe(listener);
  return () => { unsubscriptions += 1; unsubscribe(); };
};
const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), {
  ...OPEN_TUI_FRAME_PACING,
  width: 100, height: 32, kittyKeyboard: true, useThread: false, gatherStats: true,
});
function transcriptScroll(node: Renderable = setup.renderer.root): ScrollBoxRenderable | undefined {
  if (node instanceof ScrollBoxRenderable && node.content.findDescendantById("perf-user-239")) return node;
  for (const child of node.getChildren()) {
    const match = transcriptScroll(child);
    if (match) return match;
  }
  return undefined;
}
async function settle(action: () => unknown = () => undefined): Promise<void> {
  await act(async () => { await action(); });
  await act(async () => { await setup.flush(); await setup.renderer.idle(); });
}
function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return Number((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0).toFixed(3));
}
const metrics: Record<string, number | string> = {};
try {
  await settle();
  const scroll = transcriptScroll();
  assert.ok(scroll);
  assert.ok(setup.captureCharFrame().includes("HISTORY_239"));
  assert.equal(services.transcript.getState().order.length, 240);
  assert.ok(!scroll.content.findDescendantById("perf-user-0"));
  assert.equal(setup.renderer.targetFps, 60);
  assert.equal(setup.renderer.maxFps, 60);
  assert.ok(scroll.verticalScrollBar.listenerCount("change") >= 1);
  const requestFrame = globalThis.requestAnimationFrame;
  let pendingPins = 0;
  let peakPins = 0;
  globalThis.requestAnimationFrame = (callback) => {
    pendingPins += 1;
    peakPins = Math.max(peakPins, pendingPins);
    return requestFrame((time) => { pendingPins -= 1; callback(time); });
  };
  try {
    await settle(() => {
      for (let index = 0; index < 8; index += 1) transcriptScrollPort.scrollToBottom();
    });
    assert.equal(peakPins, 1);
    assert.equal(pendingPins, 0);
    metrics.peakBottomPinFrames = peakPins;
  } finally {
    globalThis.requestAnimationFrame = requestFrame;
  }
  setRenderCountersEnabled(true);
  resetRenderCounts();
  const scrollSamples: number[] = [];
  const nativeSamples: number[] = [];
  const cpuBefore = process.cpuUsage();
  for (let index = 0; index < 40; index += 1) {
    const start = performance.now();
    await settle(() => transcriptScrollPort.scrollBy(-1));
    scrollSamples.push(performance.now() - start);
    nativeSamples.push(setup.getNativeStats().nativeLastFrameTime / 1000);
  }
  const scrollCpu = process.cpuUsage(cpuBefore);
  metrics.scrollMedianMs = percentile(scrollSamples, 0.5);
  metrics.scrollP95Ms = percentile(scrollSamples, 0.95);
  metrics.nativeScrollP95Ms = percentile(nativeSamples, 0.95);
  metrics.scrollCpuMs = Number(((scrollCpu.user + scrollCpu.system) / 1000).toFixed(3));
  metrics.scrollTranscriptRenders = readRenderCounts().get("TranscriptView") ?? 0;
  await settle(() => {
    scroll.scrollTo(scroll.scrollTop - 1);
    assert.equal(transcriptScrollPort.metrics.linesAbove, Math.floor(scroll.scrollTop));
    assert.equal(transcriptScrollPort.metrics.linesBelow, Math.floor(scroll.scrollHeight - scroll.viewport.height - scroll.scrollTop));
  });
  await settle(() => transcriptScrollPort.scrollToTop());
  assert.ok(setup.captureCharFrame().includes("HISTORY_0"));
  await settle(() => transcriptScrollPort.scrollToBottom());
  assert.ok(setup.captureCharFrame().includes("HISTORY_239"));
  const seq = new EventSequencer(services.session.sessionId);
  const turnId = asTurnId("perf-stream");
  const oldSubscriptions = subscriptions;
  const oldUnsubscriptions = unsubscriptions;
  resetRenderCounts();
  const streamSamples: number[] = [];
  let body = "";
  for (let index = 0; index < 40; index += 1) {
    const start = performance.now();
    const chunk = `STREAM_${index} **complete** content 日本語 🧪\n`;
    body += chunk;
    await settle(async () => {
      services.transcript.dispatch(seq.build("assistant-delta", { text: chunk }, turnId));
      await delay(20);
    });
    streamSamples.push(performance.now() - start);
  }
  metrics.streamMedianMs = percentile(streamSamples, 0.5);
  metrics.streamP95Ms = percentile(streamSamples, 0.95);
  metrics.streamSubscriptions = subscriptions - oldSubscriptions;
  metrics.streamUnsubscriptions = unsubscriptions - oldUnsubscriptions;
  metrics.streamTranscriptRenders = readRenderCounts().get("TranscriptView") ?? 0;
  metrics.streamRowRenders = readRenderCounts().get("TranscriptRow") ?? 0;
  await settle(() => services.transcript.dispatch(seq.build("assistant-message", { messageId: seq.ids.message(), text: body }, turnId)));
  const state = services.transcript.getState();
  assert.equal(state.order.length, 241);
  assert.equal(state.byId.size, 241);
  const assistant = state.byId.get(state.order.at(-1)!);
  assert.ok(assistant?.kind === "assistant");
  assert.equal(assistant.text, body.trimEnd());
  assert.ok(setup.captureCharFrame().includes("STREAM_39"));
  await settle(() => {
    services.focus.focusRegion("composer");
    return setup.mockInput.typeText("full draft 日本語 🧪");
  });
  assert.ok(setup.captureCharFrame().includes("full draft"));
  let cursorMentionReads = 0;
  const serverNames = services.mcp.serverNames.bind(services.mcp);
  services.mcp.serverNames = () => { cursorMentionReads += 1; return serverNames(); };
  const cursorStart = performance.now();
  await settle(() => {
    for (let index = 0; index < 40; index += 1) setup.mockInput.pressArrow("left");
  });
  metrics.cursorMoveMs = Number((performance.now() - cursorStart).toFixed(3));
  metrics.cursorMentionReads = cursorMentionReads;
  services.mcp.serverNames = serverNames;
  await settle(() => services.overlay.openPager("full content", "PAGER_FIRST\n" + "middle content\n".repeat(100) + "PAGER_LAST"));
  assert.ok(setup.captureCharFrame().includes("full content"));
  await settle(() => setup.mockInput.pressEscape());
  assert.equal(services.overlay.getState().kind, "none");
  await settle(() => setup.resize(60, 22));
  assert.ok(setup.captureCharFrame().includes("full draft"));
  await settle(() => setup.resize(100, 32));
  await settle(() => transcriptScrollPort.scrollToTop());
  assert.ok(setup.captureCharFrame().includes("HISTORY_0"));
  await settle(() => transcriptScrollPort.scrollToBottom());
  assert.ok(setup.captureCharFrame().includes("STREAM_39"));
  await settle(() => services.focus.focusRegion("transcript"));
  // One-shot timers can fire late under CI
  // load; wait for the renderer to go quiet before measuring idle frames.
  let lastFrameAt = Date.now();
  const markFrame = (): void => { lastFrameAt = Date.now(); };
  setup.renderer.on("frame", markFrame);
  const quietDeadline = Date.now() + 10_000;
  while (Date.now() - lastFrameAt < 1000 && Date.now() < quietDeadline) {
    await act(async () => { await delay(200); });
  }
  setup.renderer.off("frame", markFrame);
  await setup.renderer.idle();
  resetRenderCounts();
  let idleFrames = 0;
  const onFrame = (): void => { idleFrames += 1; };
  setup.renderer.on("frame", onFrame);
  const idleCpuBefore = process.cpuUsage();
  await act(async () => { await delay(700); });
  const idleCpu = process.cpuUsage(idleCpuBefore);
  setup.renderer.off("frame", onFrame);
  metrics.idleFrames = idleFrames;
  assert.equal(idleFrames, 0);
  metrics.idleCpuMs = Number(((idleCpu.user + idleCpu.system) / 1000).toFixed(3));
  metrics.idleTranscriptRenders = readRenderCounts().get("TranscriptView") ?? 0;
  metrics.heapUsedMB = Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2));
  metrics.rssMB = Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2));
  assert.equal(metrics.idleTranscriptRenders, 0);
  console.log(JSON.stringify({ metrics }));
  assert.deepEqual({ subscriptions: metrics.streamSubscriptions, cursorMentionReads: metrics.cursorMentionReads }, { subscriptions: 0, cursorMentionReads: 0 });
  console.log("Native interaction performance passed: retained history, scroll, stream, composer, overlay and resize");
} finally {
  setRenderCountersEnabled(false);
  await act(async () => { services.dispose(); setup.renderer.destroy(); });
  await setup.renderer.idle();
}
