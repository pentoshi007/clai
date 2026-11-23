import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { act, createElement } from "react";
import { BoxRenderable, TextareaRenderable, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { App } from "../../src/tui-v2/app/App.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { EventSequencer, createCountingIdFactory } from "../../src/app/events/sequencer.js";
import { asPlanId, asSessionId } from "../../src/app/events/app-event.js";
import { createPlan } from "../../src/store/plan.js";

const services = createCompositionRoot({
  noHistory: true,
  persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  capabilities: detectCapabilities({ env: {}, stdoutIsTTY: true, stdinIsTTY: true, columns: 120, rows: 30 }),
});
const seq = new EventSequencer(asSessionId("completion-overlay"), createCountingIdFactory("overlay"));
const plan = createPlan({
  sessionId: services.session.sessionId,
  goal: "Overlay the command menu",
  detail: "",
  taskTitles: ["Inspect the layout", "Verify the pane height", "Finish"],
  kind: "ui",
});
const planEvent = seq.build("plan-updated", { planId: asPlanId("overlay-plan"), plan });
services.plan.observe(planEvent);
services.transcript.dispatch(planEvent);

const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), {
  width: 120, height: 30, kittyKeyboard: false, useThread: false,
});

const settle = async (action: () => unknown = () => undefined): Promise<void> => {
  await act(async () => { await action(); });
  await act(async () => { await setup.flush(); });
};

function findTextarea(): TextareaRenderable {
  const pending: Renderable[] = [setup.renderer.root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node instanceof TextareaRenderable) return node;
    pending.push(...node.getChildren());
  }
  throw new Error("Composer textarea is missing");
}

function borderedAncestor(node: Renderable): BoxRenderable {
  for (let current = node.parent; current; current = current.parent) {
    if (current instanceof BoxRenderable && current.border) return current;
  }
  throw new Error("Composer box is missing");
}

try {
  await settle();
  const pane = setup.renderer.root.findDescendantById("tasks-pane");
  assert.ok(pane, "the split task pane is rendered");
  const before = { y: pane.y, height: pane.height };
  assert.ok(before.height > 10, `the task pane starts tall: ${before.height}`);

  await settle(() => setup.renderer.stdin.emit("data", Buffer.from("/")));
  const frame = setup.captureCharFrame();
  assert.match(frame, /commands ·/, frame);
  assert.deepEqual(
    { y: pane.y, height: pane.height },
    before,
    `the command menu must not shorten the task pane\n${frame}`,
  );

  const menuRow = frame.split("\n").findIndex((line) => line.includes("commands ·"));
  const composer = borderedAncestor(findTextarea());
  assert.ok(
    menuRow >= 0 && menuRow < composer.y,
    `the menu row ${menuRow} must float above the composer at ${composer.y}\n${frame}`,
  );
  const menu = setup.renderer.root.findDescendantById("completion-menu");
  assert.ok(menu, "the floating menu is rendered");
  assert.ok(
    menu.x + menu.width <= pane.x,
    `the menu must stay clear of the task pane: menu ends at ${menu.x + menu.width}, pane starts at ${pane.x}\n${frame}`,
  );
  assert.ok(
    composer.y + composer.height <= 30,
    `the composer stays inside the terminal\n${frame}`,
  );
  console.log("Native completion overlay passed: the command menu floats above the composer without shortening the task pane");
  if (process.env.CLAI_OVERLAY_EVIDENCE) await writeFile(process.env.CLAI_OVERLAY_EVIDENCE, frame);
} finally {
  await act(async () => { services.dispose(); setup.renderer.destroy(); });
  await setup.renderer.idle();
}
