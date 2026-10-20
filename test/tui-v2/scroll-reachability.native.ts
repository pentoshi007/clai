import assert from "node:assert/strict";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { App } from "../../src/tui-v2/app/App.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { transcriptScrollPort } from "../../src/tui-v2/components/transcript/transcript-scroll-port.js";
import { EventSequencer, createCountingIdFactory } from "../../src/app/events/sequencer.js";
import { asMessageId, asSessionId, asTurnId } from "../../src/app/events/app-event.js";

const total = 160;
const services = createCompositionRoot({
  noHistory: true,
  persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: 90, rows: 30 }),
});
const seq = new EventSequencer(asSessionId("reach-native"), createCountingIdFactory("reach"));
for (let index = 0; index < total; index += 1) {
  const body = Array.from({ length: 1 + (index % 7) }, (_, row) => `row ${row} of ${index}`).join("\n");
  services.transcript.dispatch(seq.build("assistant-message", {
    messageId: asMessageId(`message-${index}`), text: `START_${index}\n${body}\nEND_${index}`,
  }, asTurnId("reach-turn")));
}
const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), { width: 90, height: 30, useThread: false, useMouse: true });
const seen = new Set<number>();
const record = (): void => {
  for (const match of setup.captureCharFrame().matchAll(/(?:START|END)_(\d+)/g)) seen.add(Number(match[1]));
};
const step = async (dy: number): Promise<void> => {
  await act(async () => {
    transcriptScrollPort.scrollBy(dy);
    await setup.renderOnce();
    await setup.renderOnce();
  });
  record();
};
try {
  await act(async () => { await setup.waitForFrame((frame) => frame.includes(`END_${total - 1}`)); });
  record();
  for (let guard = 0; guard < 4_000 && !setup.captureCharFrame().includes("START_0"); guard += 1) await step(-3);
  assert.ok(setup.captureCharFrame().includes("START_0"), "scrolling up reaches the first item");
  for (let index = 0; index < total; index += 1) assert.ok(seen.has(index), `item ${index} was visible while scrolling up`);
  seen.clear();
  record();
  for (let guard = 0; guard < 4_000 && !setup.captureCharFrame().includes(`END_${total - 1}`); guard += 1) await step(3);
  assert.ok(setup.captureCharFrame().includes(`END_${total - 1}`), "scrolling down reaches the last item");
  for (let index = 0; index < total; index += 1) assert.ok(seen.has(index), `item ${index} was visible while scrolling down`);
} finally {
  await act(async () => {
    services.dispose();
    setup.renderer.destroy();
  });
}
console.log("Native scroll reachability passed");
