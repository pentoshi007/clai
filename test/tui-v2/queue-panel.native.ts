import assert from "node:assert/strict";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { QueuePanel } from "../../src/tui-v2/components/queue/queue-panel.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";

for (const width of [40, 80, 120]) {
  let finish: (() => void) | undefined;
  let active: Promise<void> | undefined;
  const services = createCompositionRoot({
    noHistory: true,
    agent: {
      async runTurn(_request, handlers) {
        await new Promise<void>(resolve => {
          finish = resolve;
          handlers.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return createTurnOutcome({ status: "succeeded", answer: "done", steps: 0, remainingCriteria: [] });
      },
    },
    persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  });
  const edited: string[] = [];
  const sent: number[] = [];
  services.session.sendQueuedNow = index => { sent.push(index); };
  const setup = await testRender(createElement(QueuePanel, { services, theme: themeFor("dark"), width, onEdit: text => { edited.push(text); } }), {
    width, height: 18, useMouse: true, useThread: false,
  });
  const settle = async (action: () => unknown = () => undefined): Promise<string> => {
    await act(async () => {
      await action();
      await new Promise<void>(resolve => setTimeout(resolve, 20));
      await setup.flush();
    });
    return setup.captureCharFrame();
  };
  const click = async (label: string): Promise<string> => {
    const lines = setup.captureCharFrame().split("\n");
    const y = lines.findIndex(line => line.includes(label));
    assert.ok(y >= 0, `${label} must remain visible at ${width} columns`);
    return settle(() => setup.mockMouse.click(lines[y]!.indexOf(label) + 1, y));
  };
  try {
    assert.equal((await settle()).trim(), "");
    const single = await settle(() => services.session.enqueue("Queued draft"));
    assert.doesNotMatch(single, /waiting|sends after completion|click Send now|Send now or Edit/);
    assert.match(single, /Queued dra/);
    assert.equal(single.split("\n").filter(line => line.trim()).length, 3, "one prompt needs only its row and two borders");
    await click("[Send now]");
    assert.deepEqual(sent, [0]);
    await click("[Edit]");
    assert.deepEqual(edited, ["Queued draft"]);
    assert.equal((await settle()).trim(), "");
    const overflow = await settle(() => {
      for (let index = 0; index < 6; index += 1) services.session.enqueue(`Queued ${index}`);
    });
    assert.match(overflow, /2 more in queue/);
    assert.equal(overflow.split("\n").filter(line => line.trim()).length, 7);
    await click("[×]");
    assert.equal(services.session.getState().queued[0], "Queued 1");
    const running = await settle(() => { active = services.session.submit("Active turn"); });
    assert.equal(services.session.getState().running, true);
    assert.doesNotMatch(running, /waiting|sends after completion|click Send now|Send now or Edit/);
  } finally {
    await act(async () => {
      while (services.session.getState().queued.length) services.session.removeQueued(0);
      finish?.();
      await active;
      services.dispose();
      setup.renderer.destroy();
    });
    await setup.renderer.idle();
  }
}
console.log("Native queue panel passed: no waiting/instruction line, compact height, idle/running state, Send now/Edit/remove and overflow at 40/80/120 columns");
