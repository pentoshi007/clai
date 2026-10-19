import assert from "node:assert/strict";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { App } from "../../src/tui-v2/app/App.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { EventSequencer, createCountingIdFactory } from "../../src/app/events/sequencer.js";
import { asPlanId, asSessionId, asTurnId } from "../../src/app/events/app-event.js";
import { createPlan } from "../../src/store/plan.js";

const HEIGHT = 40;
const LONG_PROMPT = Array.from({ length: 12 }, (_, index) => `prompt line ${index + 1} keeps going to exercise wrapping`).join("\n");

for (const width of [100, 140]) {
  const services = createCompositionRoot({
    noHistory: true,
    persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
    capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: width, rows: HEIGHT }),
  });
  const plan = createPlan({ sessionId: services.session.sessionId, goal: "Prompt layout", detail: "native", taskTitles: ["Inspect", "Verify"], kind: "ui" });
  plan.status = "in_progress";
  services.plan.observe(new EventSequencer(services.session.sessionId).build("plan-updated", { planId: asPlanId("prompt-layout"), plan }));
  const seq = new EventSequencer(asSessionId("prompt-layout"), createCountingIdFactory("prompt"));
  services.transcript.dispatch(seq.build("turn-started", { prompt: LONG_PROMPT }, asTurnId("prompt-turn")));
  services.session.enqueue("queued follow-up");
  const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), { width, height: HEIGHT, useThread: false, useMouse: true });
  const settle = async (action: () => unknown = () => undefined): Promise<string[]> => {
    await act(async () => { await action(); await setup.flush(); });
    return setup.captureCharFrame().split("\n");
  };
  try {
    const userItemId = [...services.transcript.getState().byId.values()].find(item => item.kind === "user")!.id;
    const disclosure = () => setup.renderer.root.findDescendantById(`${userItemId}-disclosure`);
    let frame = await settle();
    await act(async () => { await setup.waitFor(() => disclosure() !== undefined); });
    frame = await settle();

    const firstRow = frame.findIndex(line => line.includes("prompt line 1 "));
    const toggleRow = frame.findIndex(line => line.includes("+ click to expand"));
    assert.ok(firstRow >= 0 && toggleRow > firstRow, frame.join("\n"));
    assert.equal(toggleRow - firstRow, 5, "a collapsed prompt keeps five text rows plus its disclosure");
    assert.equal(frame[toggleRow]!.indexOf("+ click"), frame[firstRow]!.indexOf("prompt line 1"), "disclosure aligns with the prompt text column");
    assert.match(frame[toggleRow]!, /\(\d+ more lines\)/);
    const cardLeft = frame[firstRow]!.indexOf("│");
    for (let row = firstRow + 1; row <= toggleRow; row += 1) {
      assert.equal(frame[row]!.indexOf("│"), cardLeft, "continuation rows share the card border");
    }

    const cardRight = frame[firstRow - 1]!.indexOf("╮");
    const queueTop = frame.findIndex(line => line.includes("╭─ queued"));
    assert.equal(frame[queueTop]!.indexOf("╮"), cardRight, "queue panel matches the transcript width");
    const composerRow = frame.findIndex(line => line.includes("┏"));
    if (width >= 120) assert.match(frame[composerRow - 1]!, /╰─+╯\s+╰─+╯/, "tasks pane reaches the composer beside the queue");

    const target = disclosure()!;
    frame = await settle(() => setup.mockMouse.click(target.x, target.y));
    assert.equal(services.overlay.getState().kind, "none", "the disclosure toggles in place");
    assert.ok(frame.some(line => line.includes("- click to collapse")));
    assert.ok(frame.some(line => line.includes("prompt line 12")));

    const textRow = frame.findIndex(line => line.includes("prompt line 2 "));
    await settle(() => setup.mockMouse.click(frame[textRow]!.indexOf("prompt line 2") + 2, textRow));
    const state = services.overlay.getState();
    assert.equal(state.kind, "pager", "clicking the prompt opens the pager directly");
    assert.equal(state.kind === "pager" ? state.body : "", LONG_PROMPT);
  } finally {
    await act(async () => {
      while (services.session.getState().queued.length) services.session.removeQueued(0);
      services.dispose();
      setup.renderer.destroy();
    });
    await setup.renderer.idle();
  }
}
console.log("Native prompt layout passed: aligned collapsible prompt, direct pager, transcript-width queue beside a full-height tasks pane");
