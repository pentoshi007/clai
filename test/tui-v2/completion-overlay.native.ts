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

const WIDTH = 80;
const HEIGHT = 25;
const services = createCompositionRoot({
  noHistory: true,
  persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  capabilities: detectCapabilities({ env: {}, stdoutIsTTY: true, stdinIsTTY: true, columns: WIDTH, rows: HEIGHT }),
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
  width: WIDTH, height: HEIGHT, kittyKeyboard: false, useThread: false, useMouse: true,
});

async function settle(action: () => unknown = () => undefined): Promise<void> {
  await act(async () => { await action(); });
  await act(async () => { await setup.flush(); });
}

function find(id: string): Renderable | undefined {
  return setup.renderer.root.findDescendantById(id);
}

function required(id: string): Renderable {
  const node = find(id);
  assert.ok(node, `Missing ${id}\n${setup.captureCharFrame()}`);
  return node;
}

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

async function click(id: string): Promise<void> {
  const button = required(id);
  await settle(() => setup.mockMouse.click(button.x, button.y));
  await settle(() => services.toast.clear());
}

async function openMenu(): Promise<Renderable> {
  await settle(() => setup.renderer.stdin.emit("data", Buffer.from("/")));
  return required("completion-menu");
}

async function closeMenu(): Promise<void> {
  await settle(() => setup.mockInput.pressEscape());
  await settle(() => setup.mockInput.pressBackspace());
  assert.equal(find("completion-menu"), undefined);
}

async function verifyMenuOverPane(): Promise<string> {
  const pane = required("plan-pane");
  const before = { y: pane.y, height: pane.height };
  assert.ok(before.height > 10);
  const menu = await openMenu();
  const frame = setup.captureCharFrame();
  const rows = frame.split("\n");
  const header = rows[menu.y + 1]!;
  const composer = borderedAncestor(findTextarea());
  const { width, height } = setup.renderer.root;
  assert.deepEqual({ y: pane.y, height: pane.height }, before, "The menu must not shorten the Tasks pane");
  assert.equal(menu.x, 0);
  assert.equal(menu.width, width);
  assert.ok(menu.y >= 0 && menu.y + menu.height === composer.y, frame);
  assert.ok(composer.y + composer.height <= height, frame);
  assert.match(header, /commands · \d+.*wheel:scroll.*tab:complete/, frame);
  assert.equal(header[width - 1], "│", `The menu must paint across the right side of Tasks\n${frame}`);

  const wheelY = Math.max(pane.y, menu.y + 3);
  assert.ok(wheelY < Math.min(menu.y + menu.height - 1, pane.y + pane.height), frame);
  await settle(() => setup.mockMouse.scroll(width - 3, wheelY, "down"));
  assert.match(setup.captureCharFrame(), /earlier match/, "The right side of the menu must receive mouse input");
  assert.equal(services.focus.activeContext(), "composer");
  await closeMenu();
  assert.equal(find("plan-pane"), pane, "Dismissing the menu must leave Tasks open");
  return frame;
}

async function verifyResponsiveTasks(): Promise<void> {
  await settle();
  assert.equal(find("plan-pane"), undefined, "Tasks must start collapsed at 80×25");
  required("status-tasks-toggle");
  const menu = await openMenu();
  assert.equal(menu.width, WIDTH);
  assert.match(setup.captureCharFrame(), /commands · \d+.*tab:complete/);
  await settle(() => setup.resize(120, 30));
  assert.equal(required("completion-menu").width, 120);
  assert.match(setup.captureCharFrame(), /commands · \d+.*esc:dismiss/);
  await settle(() => setup.resize(WIDTH, HEIGHT));
  const resizedMenu = required("completion-menu");
  assert.equal(resizedMenu.width, WIDTH);
  assert.equal(resizedMenu.y + resizedMenu.height, borderedAncestor(findTextarea()).y);
  assert.equal(find("plan-pane"), undefined);
  await closeMenu();

  for (const [width, height] of [[119, 30], [120, 19]] as const) {
    await settle(() => setup.resize(width, height));
    assert.equal(find("plan-pane"), undefined, `Tasks stays collapsed at ${width}×${height}`);
  }
  await settle(() => setup.resize(120, 20));
  required("tasks-pane");
  await settle(() => setup.resize(120, 30));
  await verifyMenuOverPane();
  await settle(() => services.focus.focusRegion("plan"));
  await settle(() => setup.resize(WIDTH, HEIGHT));
  assert.equal(find("plan-pane"), undefined, "Shrinking an automatic split must not leave an overlay");
  assert.equal(services.focus.activeContext(), "transcript");
  await settle(() => services.focus.focusRegion("composer"));
}

try {
  await verifyResponsiveTasks();
  await click("status-tasks-toggle");
  const frame = await verifyMenuOverPane();
  await settle(() => setup.resize(120, 30));
  const splitPane = required("tasks-pane");
  assert.equal(splitPane.y, 0);
  assert.equal(splitPane.height, borderedAncestor(findTextarea()).y);
  await settle(() => setup.resize(WIDTH, HEIGHT));
  required("plan-pane");
  await click("plan-hide");
  await settle(() => setup.resize(120, 30));
  assert.equal(find("plan-pane"), undefined, "A manual Hide must survive an enlargement");
  await settle(() => setup.resize(48, HEIGHT));
  await click("status-tasks-toggle");
  const compactPane = required("tasks-pane");
  assert.equal(compactPane.x + compactPane.width, 48);
  await click("plan-hide");
  assert.equal(find("plan-pane"), undefined);
  console.log("Native completion overlay passed: full-width paint and mouse targets in both layouts, automatic resize and manual Tasks controls");
  if (process.env.CLAI_OVERLAY_EVIDENCE) await writeFile(process.env.CLAI_OVERLAY_EVIDENCE, frame);
} finally {
  await act(async () => { services.dispose(); setup.renderer.destroy(); });
  await setup.renderer.idle();
}
