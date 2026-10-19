import assert from "node:assert/strict";
import { act, createElement } from "react";
import { ScrollBoxRenderable, TextRenderable, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { App } from "../../src/tui-v2/app/App.js";
import { EMPTY_TRANSCRIPT_STATE, type AssistantItem } from "../../src/ui-core/state/transcript-types.js";
import { transcriptScrollPort } from "../../src/tui-v2/components/transcript/transcript-scroll-port.js";
import { EventSequencer } from "../../src/app/events/sequencer.js";
import { asTurnId } from "../../src/app/events/app-event.js";
import { setTimeout as delay } from "node:timers/promises";

let copied = "";
const services = createCompositionRoot({
  noHistory: true, provider: "openai", model: "offline",
  agent: { async runTurn() { return "offline"; } },
  clipboard: { async writeText(text) { copied = text; } },
  persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  updates: { async check() { return { state: "current", currentVersion: "test", updateAvailable: false }; } },
  capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: 100, rows: 32 }),
});
const count = Number(process.argv[2] ?? 240);
assert.ok(Number.isSafeInteger(count) && count >= 240);
const last = count - 1;
const items: AssistantItem[] = Array.from({ length: count }, (_, index) => ({
  id: `long-${index}`, kind: "assistant", streaming: false, sequence: index, timestamp: 0, turnId: undefined,
  text: Array.from({ length: 100 }, (_, row) => `ITEM_${index}_ROW_${row} 日本語 🧪 **complete**`).join("\n"),
}));
services.transcript.hydrate({ ...EMPTY_TRANSCRIPT_STATE, order: items.map((item) => item.id), byId: new Map(items.map((item) => [item.id, item])) });
const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), { width: 100, height: 32, useThread: false, kittyKeyboard: true });

async function settle(action: () => unknown = () => undefined): Promise<void> {
  await act(async () => { await action(); });
  await act(async () => { await setup.flush(); await setup.renderer.idle(); });
}
function nodes(node: Renderable = setup.renderer.root): number {
  return 1 + node.getChildren().reduce((total, child) => total + nodes(child), 0);
}
function scrollbox(node: Renderable = setup.renderer.root): ScrollBoxRenderable | undefined {
  if (node instanceof ScrollBoxRenderable && node.content.findDescendantById(`long-${last}`)) return node;
  for (const child of node.getChildren()) {
    const found = scrollbox(child);
    if (found) return found;
  }
  return undefined;
}
function body(node: Renderable): TextRenderable | undefined {
  if (node instanceof TextRenderable && node.content.chunks.some((chunk) => chunk.text.includes("ITEM_"))) return node;
  for (const child of node.getChildren()) {
    const found = body(child);
    if (found) return found;
  }
  return undefined;
}
function markerRows(): Map<string, number> {
  const rows = new Map<string, number>();
  setup.captureCharFrame().split("\n").forEach((line, index) => {
    const marker = /ITEM_\d+_ROW_\d+/.exec(line)?.[0];
    if (marker) rows.set(marker, index);
  });
  return rows;
}
async function crossWindowEdge(scroll: ScrollBoxRenderable, step: number, park: () => void, revealedId: string): Promise<void> {
  assert.equal(setup.renderer.root.findDescendantById(revealedId), undefined);
  await settle(park);
  for (let index = 0; index < 3; index += 1) {
    const before = [...markerRows()];
    const [marker, row] = step < 0 ? before[0]! : before.at(-1)!;
    await settle(() => transcriptScrollPort.scrollBy(step));
    await settle();
    assert.equal(markerRows().get(marker), row - step, `${marker} moved by exactly ${step} rows`);
  }
  assert.ok(setup.renderer.root.findDescendantById(revealedId), revealedId);
}
const metrics: Record<string, number | boolean> = {};
try {
  await settle();
  const scroll = scrollbox();
  assert.ok(scroll);
  assert.match(setup.captureCharFrame(), new RegExp(`ITEM_${last}_ROW_99`));
  metrics.nodes = nodes();
  assert.ok(metrics.nodes < 800, String(metrics.nodes));
  assert.equal(services.transcript.getState().order.length, count);
  assert.equal(setup.renderer.root.findDescendantById("long-0"), undefined);
  await crossWindowEdge(scroll, -3, () => scroll.scrollTo(4), `long-${count - 60}`);
  await settle(() => transcriptScrollPort.scrollToTop());
  await crossWindowEdge(scroll, 3, () => scroll.scrollTo(scroll.scrollHeight - scroll.viewport.height - 4), "long-60");
  await settle(() => transcriptScrollPort.scrollToTop());
  const first = setup.renderer.root.findDescendantById("long-0");
  assert.ok(first);
  const text = body(first);
  assert.ok(text);
  assert.equal(text.height, 100);
  assert.equal(text.content.chunks.map((chunk) => chunk.text).join("").split("\n").length, 100);
  for (const row of [0, 45, 90]) {
    await settle(() => scroll.scrollTo(scroll.scrollTop + text.screenY - scroll.viewport.screenY + row));
    assert.match(setup.captureCharFrame(), new RegExp(`ITEM_0_ROW_${row}`));
  }
  await settle(() => {
    services.focus.focusRegion("transcript");
    return setup.mockInput.pressKey("r", { ctrl: true });
  });
  await settle(() => setup.mockInput.typeText("ITEM_180_ROW_0"));
  await settle(() => setup.mockInput.pressEnter());
  assert.ok(setup.renderer.root.findDescendantById("long-180"));
  await settle(() => transcriptScrollPort.scrollToBottom());
  assert.match(setup.captureCharFrame(), new RegExp(`ITEM_${last}_ROW_99`));
  await settle(() => setup.resize(60, 24));
  assert.match(setup.captureCharFrame(), new RegExp(`ITEM_${last}_ROW_99`));
  await settle(() => setup.resize(100, 32));
  await settle(() => {
    services.focus.focusRegion("transcript");
    return setup.mockInput.pressKey("a", { ctrl: true });
  });
  await settle(() => setup.mockInput.pressKey("c", { ctrl: true, shift: true }));
  for (const index of [0, 119, 120, 239]) {
    assert.match(copied, new RegExp(`ITEM_${index}_ROW_0`));
    assert.match(copied, new RegExp(`ITEM_${index}_ROW_99`));
  }
  for (const item of items) assert.ok(copied.includes(item.text), item.id);
  assert.match(copied, /日本語 🧪 \*\*complete\*\*/);
  metrics.copiedCharacters = copied.length;
  await settle(() => services.selection.clear());
  const seq = new EventSequencer(services.session.sessionId);
  const turn = asTurnId("long-stream");
  await settle(async () => {
    services.transcript.dispatch(seq.build("assistant-delta", { text: "STREAM_FIRST 日本語 🧪\n" }, turn));
    await delay(20);
  });
  await settle(async () => {
    services.transcript.dispatch(seq.build("assistant-delta", { text: "STREAM_LAST complete" }, turn));
    await delay(20);
  });
  await settle(() => services.transcript.dispatch(seq.build("assistant-message", { messageId: seq.ids.message(), text: "STREAM_FIRST 日本語 🧪\nSTREAM_LAST complete" }, turn)));
  assert.match(setup.captureCharFrame(), /STREAM_LAST complete/);
  assert.equal(services.transcript.getState().order.length, count + 1);
  metrics.finalNodes = nodes();
  assert.ok(metrics.finalNodes < 850);
  metrics.rssMiB = process.memoryUsage().rss / 1048576;
  console.log("Native long-session integrity passed " + JSON.stringify(metrics));
} finally {
  await act(async () => { setup.renderer.destroy(); services.dispose(); });
  await setup.renderer.idle();
}
