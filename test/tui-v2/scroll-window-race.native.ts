import assert from "node:assert/strict";
import { act, createElement, Profiler } from "react";
import { testRender } from "@opentui/react/test-utils";
import { ScrollBoxRenderable, type Renderable } from "@opentui/core";
import { App } from "../../src/tui-v2/app/App.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { transcriptScrollPort } from "../../src/tui-v2/components/transcript/transcript-scroll-port.js";
import { EventSequencer, createCountingIdFactory } from "../../src/app/events/sequencer.js";
import { asMessageId, asSessionId, asTurnId } from "../../src/app/events/app-event.js";

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
const seq = new EventSequencer(asSessionId("window-race"), createCountingIdFactory("window"));
for (let index = 0; index < 148; index += 1) {
  services.transcript.dispatch(seq.build("assistant-message", {
    messageId: asMessageId(`message-${index}`), text: `START_${index}\n${"body\n".repeat(5)}END_${index}`,
  }, asTurnId("window-turn")));
}
let replayWheel = false;
let injected = 0;
const setup = await testRender(createElement(ServicesProvider, {
  services,
  children: createElement(Profiler, {
    id: "window-scroll",
    onRender: () => {
      if (!replayWheel) return;
      replayWheel = false;
      injected += 1;
      transcriptScrollPort.scrollBy(1);
    },
    children: createElement(App),
  }),
}), { width: 90, height: 30, useThread: false, useMouse: true });

async function settle(action: () => unknown = () => undefined): Promise<void> {
  await act(async () => { await action(); });
  await act(async () => { await setup.flush(); });
}

const requestFrame = globalThis.requestAnimationFrame;
const cancelFrame = globalThis.cancelAnimationFrame;
let frameId = -100;
try {
  await settle();
  globalThis.requestAnimationFrame = (callback) => {
    const frame = --frameId;
    callback(performance.now());
    return frame;
  };
  globalThis.cancelAnimationFrame = (frame) => { if (frame >= 0) cancelFrame(frame); };
  await settle(() => transcriptScrollPort.scrollToTop());
  const sb = findScrollBox(setup.renderer.root)!;
  assert.equal(sb.scrollTop, 0);
  for (let window = 0; window < 4; window += 1) {
    await settle(() => transcriptScrollPort.scrollBy(sb.scrollHeight - sb.viewport.height - sb.scrollTop - 5));
  }
  await settle(() => {
    replayWheel = true;
    transcriptScrollPort.scrollBy(sb.scrollHeight - sb.viewport.height - sb.scrollTop - 5);
  });
  assert.equal(injected, 1, "input is replayed after layout but before passive handlers update");
  const before = sb.scrollTop;
  await settle(() => transcriptScrollPort.wheel(-1));
  assert.equal(sb.scrollTop, before - 1, "wheel input remains live after a mount-window commit");
  await settle(() => transcriptScrollPort.wheel(-1));
  assert.equal(sb.scrollTop, before - 2, "the next idle wheel input also moves");
  assert.equal(services.transcript.getState().order.length, 148);
} finally {
  globalThis.requestAnimationFrame = requestFrame;
  globalThis.cancelAnimationFrame = cancelFrame;
  await act(async () => { services.dispose(); setup.renderer.destroy(); });
  await setup.renderer.idle();
}
console.log("Native scroll-window race passed");
