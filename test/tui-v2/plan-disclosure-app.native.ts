import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { EventSequencer } from "../../src/app/events/sequencer.js";
import { asPlanId } from "../../src/app/events/app-event.js";
import { createPlan, type SessionPlan } from "../../src/store/plan.js";
import { App } from "../../src/tui-v2/app/App.js";

let writes = 0;
const services = createCompositionRoot({
  noHistory: true,
  provider: "openai",
  model: "test-model",
  persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() { writes += 1; }, async deletePlan() { writes += 1; } },
  capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: 140, rows: 40 }),
});
const plan = createPlan({ sessionId: services.session.sessionId, goal: "Task disclosure integration", detail: "Keep runtime state separate", taskTitles: ["Inspect contracts", "Verify outcomes"], kind: "ui" });
plan.status = "in_progress";
plan.tasks[0]!.state = "in_progress";
plan.tasks[0]!.note = "Alpha proof";
plan.tasks[1]!.note = "Beta proof";
const before = JSON.stringify(plan);
const sequencer = new EventSequencer(services.session.sessionId);
function observe(value: SessionPlan): void {
  services.plan.observe(sequencer.build("plan-updated", { planId: asPlanId("disclosure-plan"), plan: value }));
}
observe(plan);
const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), { width: 140, height: 40, kittyKeyboard: true, useThread: false });
async function settle(action: () => unknown = () => undefined): Promise<string> {
  await act(async () => { await action(); });
  await act(async () => { await setup.flush(); });
  const frame = setup.captureCharFrame();
  assert.doesNotMatch(frame, /\b(?:Expand|Collapse) all\b/);
  return frame;
}
function expanded(id: string): boolean {
  return Boolean(setup.renderer.root.findDescendantById(`plan-task-${id}-details`));
}
function taskScroll(): ScrollBoxRenderable {
  const scroll = setup.renderer.root.findDescendantById("plan-tasks");
  assert.ok(scroll instanceof ScrollBoxRenderable);
  return scroll;
}
async function click(id: string): Promise<void> {
  const target = setup.renderer.root.findDescendantById(id);
  assert.ok(target, `Missing native click target ${id}`);
  await settle(() => setup.mockMouse.click(target.x, target.y));
}
function buttonStyle(id: string): string {
  const button = setup.renderer.root.findDescendantById(`plan-task-${id}-disclosure-label`);
  assert.ok(button);
  let x = 0;
  for (const span of setup.captureSpans().lines[button.y]!.spans) {
    if (button.x >= x && button.x < x + span.width) return JSON.stringify({ fg: span.fg.toInts(), bg: span.bg.toInts(), attributes: span.attributes });
    x += span.width;
  }
  throw new Error(`Missing native button pixels for ${id}`);
}
function assertCoherentTitles(source: SessionPlan, selectedId?: string): void {
  const viewport = taskScroll().viewport;
  for (const task of source.tasks) {
    const row = taskScroll().content.findDescendantById(`plan-task-${task.id}`)!;
    if (row.y >= viewport.y + viewport.height || row.y + row.height <= viewport.y) continue;
    const header = taskScroll().content.findDescendantById(`plan-task-${task.id}-header`)!;
    assert.ok(header);
    for (const line of header.getChildren()) {
      const text = line.getChildren()[0];
      assert.ok(text instanceof TextRenderable);
      if (text.y < viewport.y || text.y >= viewport.y + viewport.height) continue;
      const rendered = Array.from(setup.captureCharFrame().split("\n")[text.y] ?? "").slice(text.x, text.x + text.width).join("");
      assert.equal(rendered, text.plainText, `Real App must retain every visible ${task.id} title line at either viewport edge`);
    }
    if (header.height > viewport.height) continue;
    if (task.id === selectedId) assert.ok(header.y >= viewport.y && header.y + header.height <= viewport.y + viewport.height, `Real App must reveal the complete selected ${task.id} title`);
  }
}
async function capture(name: string): Promise<void> {
  const directory = process.env.CLAI_TEST_ARTIFACT_DIR;
  if (!directory) return;
  const data = { name, width: setup.renderer.root.width, height: setup.renderer.root.height, frame: setup.captureCharFrame(), lines: setup.captureSpans().lines.map((line, y) => ({ y, spans: line.spans.map((span) => ({ text: span.text, width: span.width, fg: span.fg.toInts(), bg: span.bg.toInts(), attributes: span.attributes })) })) };
  await writeFile(join(directory, `${name}.json`), JSON.stringify(data));
}

try {
  await settle();
  for (const [width, paneWidth] of [[64, 33], [92, 33], [120, 38], [128, 40], [140, 44], [160, 48]] as const) {
    await settle(() => setup.resize(width, 40));
    const pane = setup.renderer.root.findDescendantById("plan-pane");
    assert.ok(pane);
    assert.equal(pane.width, paneWidth - 2, `The task pane must yield one column to chat at ${width} columns`);
    assert.equal(pane.x, width - paneWidth + 1, "The task pane must retain its right-side docking");
    await capture(`app-task-width-${width}`);
  }
  await settle(() => setup.resize(140, 40));
  assert.ok(setup.renderer.root.findDescendantById("plan-hide"));
  assert.equal(setup.renderer.root.findDescendantById("status-tasks-toggle"), undefined);
  assert.equal(expanded("t1"), false);
  assert.equal(expanded("t2"), false);
  assert.doesNotMatch(setup.captureCharFrame(), /↑↓ select|Enter details|E\/C all/);
  for (const width of [140, 92]) {
    await settle(() => { setup.resize(width, 40); services.focus.focusRegion("composer"); });
    await settle(() => setup.mockMouse.moveTo(0, 0));
    const priorStyle = buttonStyle("t2");
    const priorFocus = setup.renderer.currentFocusedRenderable;
    await click("plan-task-t2-title-end");
    assert.equal(services.focus.activeContext(), "composer", `Title clicks must not focus the real App task pane at ${width} columns`);
    assert.equal(setup.renderer.currentFocusedRenderable, priorFocus, "Title clicks must leave native keyboard focus unchanged");
    assert.equal(setup.renderer.hasSelection, false, "Title clicks must not start native text selection");
    assert.equal(buttonStyle("t2"), priorStyle, "Title clicks must not highlight their disclosure button");
    assert.equal(expanded("t2"), false);
    const button = setup.renderer.root.findDescendantById("plan-task-t2-disclosure")!;
    const label = setup.renderer.root.findDescendantById("plan-task-t2-disclosure-label");
    assert.ok(label instanceof TextRenderable);
    assert.equal(button.width, 1);
    assert.equal(button.height, 1);
    assert.equal(label.width, 1);
    assert.equal(label.height, 1);
    assert.equal(label.x - button.x, button.x + button.width - label.x - label.width);
    assert.equal(label.y - button.y, button.y + button.height - label.y - label.height);
    const renderedButton = Array.from(setup.captureCharFrame().split("\n")[button.y]!).slice(button.x, button.x + button.width).join("");
    assert.equal(renderedButton, label.plainText);
    const finalTitle = setup.renderer.root.findDescendantById("plan-task-t2-title-end");
    assert.ok(finalTitle instanceof TextRenderable);
    assert.ok(finalTitle.plainText.slice(2).trim());
    assert.equal(label.x, finalTitle.x + finalTitle.width + 1);
    assert.equal(label.y, finalTitle.y);
    for (const x of [button.x - 1, button.x + button.width]) {
      await settle(() => setup.mockMouse.click(x, button.y));
      assert.equal(services.focus.activeContext(), "composer", "The spaces beside the button must not focus the task pane");
      assert.equal(expanded("t2"), false, "Only the icon cell must toggle disclosure");
      assert.equal(setup.renderer.hasSelection, false, "Clicking beside a button must not start native text selection");
    }
    for (let offset = 0; offset < button.width; offset++) {
      await settle(() => setup.mockMouse.click(button.x + offset, button.y));
      assert.equal(expanded("t2"), true, `The icon cell must expand the task at offset ${offset}`);
      await settle(() => setup.mockMouse.click(button.x + offset, button.y));
      assert.equal(expanded("t2"), false, `The icon cell must collapse the task at offset ${offset}`);
    }
    await click("plan-task-t2-disclosure");
    assert.equal(services.focus.activeContext(), "plan");
    assert.equal(expanded("t2"), true);
    assert.equal(setup.renderer.hasSelection, false, "Disclosure clicks must not start native text selection");
    await settle(() => setup.mockMouse.moveTo(0, 0));
    assert.equal(buttonStyle("t2"), priorStyle, "Mouse clicks must not latch the blue button background after mouse-out");
    const firstStyle = buttonStyle("t1");
    await settle(() => setup.mockInput.pressArrow("up"));
    assert.notEqual(buttonStyle("t1"), firstStyle, "Keyboard navigation must show the focused disclosure control");
    await settle(() => setup.mockInput.pressArrow("down"));
    assert.notEqual(buttonStyle("t2"), priorStyle, "Keyboard focus must follow the selected task");
    await click("plan-task-t2-disclosure");
    await settle(() => setup.mockMouse.moveTo(0, 0));
    assert.equal(expanded("t2"), false);
    assert.equal(buttonStyle("t2"), priorStyle, "A mouse click after keyboard input must clear the persistent focus highlight");
    await click("plan-task-t2-disclosure");
    await settle(() => setup.mockMouse.moveTo(0, 0));
    assert.equal(expanded("t2"), true);
    assert.equal(buttonStyle("t2"), priorStyle);
    await settle(() => services.focus.focusRegion("composer"));
    const detailFocus = setup.renderer.currentFocusedRenderable;
    await click("plan-task-t2-details");
    assert.equal(services.focus.activeContext(), "composer", "Expanded detail clicks must not focus the real App task pane");
    assert.equal(setup.renderer.currentFocusedRenderable, detailFocus, "Detail clicks must leave native keyboard focus unchanged");
    assert.equal(setup.renderer.hasSelection, false, "Expanded detail clicks must not start native text selection");
    assert.equal(expanded("t2"), true);
    await click("plan-task-t2-disclosure");
    assert.equal(services.focus.activeContext(), "plan");
    assert.equal(expanded("t2"), false);
    assert.equal(setup.renderer.hasSelection, false, "Disclosure must not start native text selection");
    await capture(`app-button-only-${width}`);
  }
  await settle(() => setup.resize(140, 40));
  await settle(() => services.focus.focusRegion("plan"));
  await settle(() => setup.mockInput.pressArrow("up"));
  let frame = await settle(() => setup.mockInput.pressEnter());
  assert.match(frame, /Alpha proof/);
  assert.equal(services.overlay.getState().kind, "none", "Enter must toggle inline details, not open the pager");
  await settle(() => setup.mockInput.pressArrow("right"));
  assert.equal(expanded("t1"), true);
  await settle(() => setup.mockInput.pressArrow("left"));
  assert.equal(expanded("t1"), false);
  await settle(() => setup.mockInput.pressEnter());
  assert.equal(expanded("t1"), true, "Enter must reopen the selected task");
  await settle(() => setup.mockInput.pressArrow("down"));
  await settle(() => setup.mockInput.pressEnter());
  assert.equal(expanded("t2"), true);
  await settle(() => setup.mockInput.pressArrow("up"));
  await settle(() => setup.mockInput.pressEnter());
  assert.equal(expanded("t1"), false);
  assert.equal(expanded("t2"), true);
  await settle(() => setup.mockInput.pressKey("e"));
  assert.equal(expanded("t1"), true);
  assert.equal(expanded("t2"), true);
  await settle(() => setup.mockInput.pressKey("c"));
  assert.equal(expanded("t1"), false);
  assert.equal(expanded("t2"), false);

  await settle(() => services.focus.focusRegion("composer"));
  await settle(() => setup.mockInput.typeText("ec"));
  assert.equal(expanded("t1"), false, "Typing in the composer must not expand the plan");
  assert.equal(expanded("t2"), false);
  await settle(() => setup.mockInput.pressKey("q", { ctrl: true }));
  await settle(() => services.focus.focusRegion("plan"));
  await settle(() => setup.mockInput.pressKey("p", { ctrl: true }));
  await setup.waitFor(() => services.overlay.getState().kind === "pager");
  assert.equal(services.overlay.getState().kind, "pager", "Ctrl+P must still open the full plan");
  await settle(() => setup.mockInput.pressKey("e"));
  assert.equal(expanded("t1"), false, "Pager keys must not reach task disclosure");
  await settle(() => setup.mockInput.pressEscape());
  assert.equal(services.overlay.getState().kind, "none");

  let secret: Promise<string | undefined> = Promise.resolve(undefined);
  await settle(() => { secret = services.overlay.openSecret({ title: "Test overlay", prompt: "Background task controls must stay inactive" }); });
  await settle(() => setup.mockInput.pressKey("e"));
  assert.equal(expanded("t1"), false, "Secret input must not reach the task pane");
  await settle(() => setup.mockInput.pressEscape());
  assert.equal(await secret, undefined);
  await settle(() => services.focus.focusRegion("plan"));
  await settle(() => setup.mockInput.pressEnter());
  assert.equal(expanded("t1"), true);

  for (const [width, height] of [[92, 30], [68, 20], [44, 14], [24, 10], [8, 4], [140, 40]]) {
    frame = await settle(() => setup.resize(width!, height!));
    const pane = setup.renderer.root.findDescendantById("plan-pane");
    if (width! >= 68) {
      assert.ok(pane);
      assert.ok(pane.x >= 0 && pane.x + pane.width <= width!);
      assert.equal(expanded("t1"), true, "Layout changes must retain disclosure state");
    } else {
      assert.equal(pane, undefined, "Tiny terminals must use existing pane suppression");
      assert.notEqual(services.focus.activeContext(), "plan");
    }
    assert.ok(frame.split("\n").length <= height! + 1);
  }
  assert.match(frame, /Alpha proof/);
  for (const width of [140, 92]) {
    await settle(() => setup.resize(width, 40));
    assert.ok(setup.renderer.root.findDescendantById("plan-hide"));
    assert.equal(setup.renderer.root.findDescendantById("status-tasks-toggle"), undefined);
    await click("plan-hide");
    assert.equal(setup.renderer.root.findDescendantById("plan-pane"), undefined);
    assert.equal(services.focus.activeContext(), "composer");
    assert.ok(setup.renderer.root.findDescendantById("status-tasks-toggle"));
    await capture(`app-tasks-hidden-${width}`);
    await settle(() => observe({ ...plan, updatedAt: `2026-10-26T12:00:${width === 140 ? "01" : "02"}Z` }));
    assert.equal(setup.renderer.root.findDescendantById("plan-pane"), undefined, "Live updates must preserve the Hide choice");
    await click("status-tasks-toggle");
    assert.ok(setup.renderer.root.findDescendantById("plan-hide"));
    assert.equal(setup.renderer.root.findDescendantById("status-tasks-toggle"), undefined);
    assert.equal(expanded("t1"), true, "Mouse hide/show must preserve explicit disclosure");
    await capture(`app-tasks-visible-${width}`);
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await settle(() => setup.mockInput.pressKey("h", { ctrl: true }));
      assert.equal(setup.renderer.root.findDescendantById("plan-pane"), undefined);
      assert.ok(setup.renderer.root.findDescendantById("status-tasks-toggle"));
      await settle(() => setup.mockInput.pressKey("h", { ctrl: true }));
      assert.equal(expanded("t1"), true, "Keyboard hide/show must preserve explicit disclosure");
      assert.equal(setup.renderer.root.findDescendantById("status-tasks-toggle"), undefined);
    }
  }
  await settle(() => setup.resize(140, 40));

  const updated: SessionPlan = { ...plan, updatedAt: "2026-10-11T19:30:01Z", tasks: [{ ...plan.tasks[0]!, note: "Alpha proof updated" }, plan.tasks[1]!, { id: "t3", title: "New live task", state: "pending", note: "Gamma proof" }] };
  frame = await settle(() => observe(updated));
  assert.equal(expanded("t1"), true);
  assert.equal(expanded("t3"), false);
  assert.match(frame, /Alpha proof updated/);
  await settle(() => services.focus.focusRegion("plan"));
  await settle(() => setup.mockInput.pressKey("c"));
  await settle(() => setup.mockInput.pressKey("e"));
  assert.equal(expanded("t3"), true);
  const fresh: SessionPlan = { ...updated, createdAt: "2026-10-11T19:30:02Z", updatedAt: "2026-10-11T19:30:02Z" };
  await settle(() => observe(fresh));
  assert.equal(expanded("t1"), false);
  assert.equal(expanded("t3"), false);
  await settle(() => setup.mockInput.pressKey("e"));
  await settle(() => services.plan.clear());
  await settle(() => observe(fresh));
  assert.equal(expanded("t1"), false, "History reload after clear must start collapsed");

  const scrolling: SessionPlan = { ...fresh, goal: "Readable wrapped tasks", status: "completed", createdAt: "2026-10-12T06:00:03Z", tasks: Array.from({ length: 12 }, (_, index) => ({
    id: `t${index + 1}`,
    title: index === 0 ? "Verify task disclosure and ten-file reads end to end" : index === 1 ? "Restore original task styling with inline disclosure" : `Verify task ${index + 1} preserves its complete wrapped title and findings`,
    state: "done",
    note: Array.from({ length: 20 }, (_, line) => `Evidence ${index + 1}:${line + 1} remains readable and available.`).join(" "),
  })) };
  await settle(() => { observe(scrolling); setup.resize(140, 30); services.focus.focusRegion("composer"); services.toast.clear(); });
  await capture("app-scroll-collapsed");
  const viewport = taskScroll().viewport;
  for (let index = 0; index < 8; index++) {
    await settle(() => setup.mockMouse.scroll(viewport.x + 3, viewport.y + 1, "down"));
    assert.equal(services.focus.activeContext(), "plan");
    assertCoherentTitles(scrolling);
  }
  await capture("app-scroll-wheel");
  await settle(() => taskScroll().scrollTo(taskScroll().scrollHeight));
  const bottom = taskScroll().scrollTop;
  assert.ok(bottom > 0, "The task pane must genuinely overflow for the bottom-boundary regression");
  for (let index = 0; index < 6; index++) {
    await settle(() => services.focus.focusRegion("composer"));
    assert.equal(taskScroll().scrollTop, bottom, "Leaving the task pane must not reveal a stale task selection");
    const changes: number[] = [];
    const record = (): void => { changes.push(taskScroll().scrollTop); };
    taskScroll().verticalScrollBar.on("change", record);
    await settle(() => setup.mockMouse.scroll(viewport.x + 3, viewport.y + 1, "down"));
    taskScroll().verticalScrollBar.off("change", record);
    assert.equal(services.focus.activeContext(), "plan", "Wheel input must still focus the task pane");
    assert.equal(taskScroll().scrollTop, bottom, "Scrolling past the final task must preserve the bottom position after refocusing");
    assert.ok(changes.every((position) => position === bottom), "No intermediate frame may jump to a task header at the top");
    assertCoherentTitles(scrolling);
  }
  await settle(() => taskScroll().scrollTo(Math.floor(bottom / 2)));
  const middle = taskScroll().scrollTop;
  await settle(() => services.focus.focusRegion("composer"));
  await settle(() => setup.mockMouse.scroll(viewport.x + 3, viewport.y + 1, "down"));
  assert.ok(taskScroll().scrollTop >= middle, "Refocusing while scrolling down must never move backward");
  await capture("app-scroll-refocus-stable");
  for (let index = 0; index < 11; index++) {
    await settle(() => setup.mockInput.pressArrow("down"));
    assertCoherentTitles(scrolling, `t${index + 2}`);
  }
  await capture("app-scroll-keyboard");
  await settle(() => setup.mockInput.pressKey("e"));
  await settle(() => taskScroll().scrollTo(0));
  await settle(() => setup.mockInput.pressKeys(["\u001b[6~"]));
  assert.ok(taskScroll().scrollTop > 0, "Real App PageDown must scroll expanded findings");
  assertCoherentTitles(scrolling);
  await capture("app-scroll-expanded-page");
  await settle(() => setup.mockInput.pressKeys(["\u001b[5~"]));
  assert.equal(taskScroll().scrollTop, 0, "Real App PageUp must return to the beginning");
  for (let index = 0; index < 10; index++) {
    await settle(() => setup.mockMouse.scroll(viewport.x + 3, viewport.y + 1, "down"));
    assertCoherentTitles(scrolling);
  }
  await settle(() => setup.mockInput.pressKey("c"));
  assertCoherentTitles(scrolling);
  await capture("app-scroll-collapse-after-reading");
  assert.equal(writes, 0);
  assert.equal(JSON.stringify(plan), before);
  console.log("Native task disclosure passed: real App keyboard, overlay priority, typing isolation, responsive remounts, pane toggles and plan identity");
} finally {
  await act(async () => { setup.renderer.destroy(); });
  services.dispose();
}
