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

for (const width of [40, 80, 120]) {
  const services = createCompositionRoot({
    noHistory: true,
    persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
    capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: width, rows: 32 }),
  });
  const seq = new EventSequencer(asSessionId("jump-native"), createCountingIdFactory("jump"));
  const append = (index: number): void => services.transcript.dispatch(seq.build("assistant-message", {
    messageId: asMessageId(`message-${index}`), text: `MESSAGE_${index}\nbody ${index}\nEND_${index}`,
  }, asTurnId("jump-turn")));
  for (let index = 0; index < 240; index += 1) append(index);
  services.session.enqueue("queued first");
  services.session.enqueue("queued second");
  const queued = services.session.getState().queued;
  const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), { width, height: 32, useThread: false, useMouse: true });
  async function settle(action: () => unknown = () => undefined): Promise<void> {
    await act(async () => { await action(); await setup.flush(); });
  }
  const button = () => setup.renderer.root.findDescendantById("jump-to-latest");
  try {
    await settle();
    await act(async () => { await setup.waitForFrame(frame => frame.includes("END_239")); });
    assert.equal(button(), undefined, "the latest view has no jump button");
    await settle(() => transcriptScrollPort.scrollToTop());
    await act(async () => { await setup.waitFor(() => button() !== undefined); });
    assert.ok(transcriptScrollPort.metrics.hasNewerContent, "an older mounted window still has newer content");
    const target = button()!;
    assert.ok(target.x >= 0 && target.x + target.width <= width, setup.captureCharFrame());
    if (width >= 80) {
      const row = setup.captureCharFrame().split("\n")[target.y]!;
      assert.match(row.slice(0, target.x), /2(?: queued|q)/, "the jump control follows the queue hint");
    }
    await settle(() => setup.mockMouse.click(target.x + 1, target.y));
    await act(async () => { await setup.waitForFrame(frame => frame.includes("END_239") && !button()); });
    assert.equal(transcriptScrollPort.metrics.linesBelow, 0);
    assert.equal(Boolean(transcriptScrollPort.metrics.hasNewerContent), false);
    await settle(() => append(240));
    await act(async () => { await setup.waitForFrame(frame => frame.includes("END_240")); });
    assert.equal(button(), undefined, "clicking restores follow mode");
    await settle(() => transcriptScrollPort.scrollBy(-12));
    await act(async () => { await setup.waitFor(() => button() !== undefined); });
    const stale = { x: button()!.x + 1, y: button()!.y };
    await settle(() => services.overlay.openPager("blocking overlay", "body"));
    assert.equal(button(), undefined, "blocking overlays hide the control");
    await settle(() => setup.mockMouse.click(stale.x, stale.y));
    await settle(() => services.overlay.close());
    await act(async () => { await setup.waitFor(() => button() !== undefined); });
    await settle(() => setup.mockInput.pressKey("d", { ctrl: true }));
    await act(async () => { await setup.waitForFrame(frame => frame.includes("END_240") && !button()); });
    await settle(() => transcriptScrollPort.scrollBy(-12));
    await settle(() => setup.resize(68, 28));
    if (setup.captureCharFrame().includes("END_240")) assert.equal(button(), undefined, "resize hides the control if the latest row becomes visible");
    await settle(() => transcriptScrollPort.scrollBy(-36));
    await act(async () => { await setup.waitForFrame(() => button() !== undefined); });
    const resized = button()!;
    assert.ok(resized.x >= 0 && resized.x + resized.width <= 68, setup.captureCharFrame());
    await settle(() => setup.mockMouse.click(resized.x + 1, resized.y));
    await act(async () => { await setup.waitForFrame(frame => frame.includes("END_240") && !button()); });
    assert.deepEqual(services.session.getState().queued, queued, "jumping and resizing preserve the queue");
  } finally {
    await act(async () => { services.dispose(); setup.renderer.destroy(); });
    await setup.renderer.idle();
  }
}
console.log("Native jump-to-latest passed: hidden at tail, older-window navigation, true latest, resumed follow, overlays and Ctrl+D at 40/80/120 columns");
