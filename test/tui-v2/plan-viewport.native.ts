import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import stringWidth from "string-width";
import { act, createElement, createRef, useState } from "react";
import { LinearScrollAccel, ScrollBoxRenderable, TextRenderable, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities, type ThemeHint } from "../../src/ui-core/bootstrap/capabilities.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";
import { createPlan, type SessionPlan } from "../../src/store/plan.js";
import { PlanView } from "../../src/tui-v2/components/plan/plan-view.js";
import { useTaskDisclosureBinding, type TaskDisclosureBinding } from "../../src/tui-v2/components/plan/use-task-disclosure.js";
import type { PlanInteractionPort } from "../../src/tui-v2/components/plan/plan-interaction.js";

const services = createCompositionRoot({
  noHistory: true,
  provider: "openai",
  model: "test-model",
  persistence: {
    async saveSession() {},
    async loadPlan() { return undefined; },
    async savePlan() { throw new Error("Viewport interaction must not save the plan"); },
    async deletePlan() { throw new Error("Viewport interaction must not delete the plan"); },
  },
  capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: 48, rows: 26 }),
});
const source = createPlan({ sessionId: services.session.sessionId, goal: "Readable task titles", detail: "", kind: "ui", taskTitles: [
  "Verify task disclosure and ten-file reads end to end",
  "Restore original task styling with inline disclosure",
  "Verify button styling and task scrolling together",
  "Keep all task titles readable without losing any words",
  "Preserve original formatting and task details",
  "Verify nested responder tasks and their complete titles",
  "Retain every expanded finding during wheel scrolling",
  "Reach the last task without clipped title endings",
] });
source.status = "completed";
for (const task of source.tasks) {
  task.state = "done";
  task.note = Array.from({ length: 12 }, (_, index) => `Finding ${task.id}:${index + 1} remains reachable.`).join(" ");
}
source.tasks[5] = { ...source.tasks[5]!, parentTaskId: "t5", responderOwned: true, jobId: "viewport-fixture", processId: 123 };
const before = JSON.stringify(source);
interface ViewState { plan: SessionPlan; width: number; height: number; focused: boolean; theme: ThemeHint }
let view: ViewState = { plan: source, width: 48, height: 26, focused: false, theme: "dark" };
let updateView: (state: ViewState) => void = () => { throw new Error("View has not mounted"); };
let binding: TaskDisclosureBinding;
const interactionRef = createRef<PlanInteractionPort>();
function Harness() {
  const [state, setState] = useState(view);
  updateView = setState;
  binding = useTaskDisclosureBinding(state.plan);
  return createElement("box", { border: true, style: { width: "100%", height: "100%", borderColor: themeFor(state.theme).inputBorder } },
    createElement(PlanView, { theme: themeFor(state.theme), plan: state.plan, services, width: state.width, focused: state.focused, interactionRef, disclosureBinding: binding }));
}
const setup = await testRender(createElement(Harness), { width: view.width, height: view.height, useThread: false });
const violations = new Set<string>();
const clippedTitleEdges = new Set<"top" | "bottom">();
async function settle(action: () => unknown = () => undefined): Promise<void> {
  await act(async () => { await action(); });
  await act(async () => { await setup.flush(); });
}
function node(id: string): Renderable {
  const value = setup.renderer.root.findDescendantById(id);
  assert.ok(value, `Missing native node ${id}`);
  return value;
}
function scrollbox(): ScrollBoxRenderable {
  const value = node("plan-tasks");
  assert.ok(value instanceof ScrollBoxRenderable);
  return value;
}
function check(condition: boolean, message: string): void {
  if (!condition) violations.add(message);
}
function textAt(x: number, y: number, width: number): string {
  return Array.from(setup.captureCharFrame().split("\n")[y] ?? "").slice(x, x + width).join("");
}
function viewportText(): string {
  const viewport = scrollbox().viewport;
  return setup.captureCharFrame().split("\n").slice(viewport.y, viewport.y + viewport.height)
    .map((line) => Array.from(line).slice(viewport.x, viewport.x + viewport.width).join("")).join("\n");
}
function inspectTitles(): void {
  const viewport = scrollbox().viewport;
  const bottom = viewport.y + viewport.height;
  let visibleTitles = 0;
  for (const task of view.plan.tasks) {
    const row = node(`plan-task-${task.id}`);
    if (row.y >= bottom || row.y + row.height <= viewport.y) continue;
    const header = node(`plan-task-${task.id}-header`);
    for (const line of header.getChildren()) {
      const text = line.getChildren()[0];
      assert.ok(text instanceof TextRenderable);
      const context = `${view.width}x${view.height} ${task.id}`;
      if (text.y < viewport.y || text.y >= bottom) continue;
      if (header.y < viewport.y) clippedTitleEdges.add("top");
      if (header.y + header.height > bottom) clippedTitleEdges.add("bottom");
      visibleTitles += 1;
      check(text.x + text.width <= header.x + header.width, `Title overflows its original padded area: ${context}`);
      check(textAt(text.x, text.y, text.width) === text.plainText, `Title text lost or rewrapped in native cells: ${context}`);
    }
    const button = setup.renderer.root.findDescendantById(`plan-task-${task.id}-disclosure`);
    if (button) {
      if (button.y >= viewport.y && button.y < bottom) {
        check(button.width === 1 && button.height === 1, "Disclosure icons must not reserve extra padding cells");
        const end = node(`plan-task-${task.id}-title-end`);
        check(button.y === end.y && button.x === end.x + end.width + 1, `Disclosure must follow the final title word: ${view.width}x${view.height} ${task.id}`);
        check(button.x + button.width <= header.x + header.width, `Button overflows the title area: ${view.width}x${view.height} ${task.id}`);
        check(textAt(button.x, button.y, button.width) === (binding!.state.expanded.has(task.id) ? "−" : "+"), `Visible disclosure icon lost at a viewport edge: ${view.width}x${view.height} ${task.id}`);
      }
    }
    const details = setup.renderer.root.findDescendantById(`plan-task-${task.id}-details`);
    for (const text of details?.getChildren() ?? []) {
      assert.ok(text instanceof TextRenderable);
      if (text.y >= viewport.y && text.y < bottom) {
        check(textAt(text.x, text.y, stringWidth(text.plainText)) === text.plainText, `Expanded detail text lost in native cells: ${view.width}x${view.height} ${task.id}`);
      }
    }
  }
  if (binding!.state.expanded.size === 0) check(visibleTitles > 0, `Collapsed scrolling must keep a task title visible: ${view.width}x${view.height}`);
}
async function wheel(direction: "up" | "down"): Promise<void> {
  const viewport = scrollbox().viewport;
  await settle(() => setup.mockMouse.scroll(viewport.x + 3, viewport.y + 1, direction));
  inspectTitles();
}
async function rerender(next: ViewState): Promise<void> {
  view = next;
  await settle(() => { updateView(next); setup.resize(next.width, next.height); });
}
async function capture(name: string): Promise<void> {
  const directory = process.env.CLAI_TEST_ARTIFACT_DIR;
  if (!directory) return;
  const data = { name, width: view.width, height: view.height, frame: setup.captureCharFrame(), lines: setup.captureSpans().lines.map((line, y) => ({ y, spans: line.spans.map((span) => ({ text: span.text, width: span.width, fg: span.fg.toInts(), bg: span.bg.toInts(), attributes: span.attributes })) })) };
  await writeFile(join(directory, `${name}.json`), JSON.stringify(data));
}
async function click(id: string): Promise<void> {
  const target = node(id);
  await settle(() => setup.mockMouse.click(target.x + Math.min(1, target.width - 1), target.y));
}

try {
  await settle();
  scrollbox().scrollAcceleration = new LinearScrollAccel();
  inspectTitles();
  await capture("bordered-initial");
  for (let index = 0; index < 8; index++) await wheel("down");
  await capture("bordered-wheel");
  for (let index = 0; index < 80; index++) await wheel("down");
  check(scrollbox().scrollTop === Math.max(0, scrollbox().scrollHeight - scrollbox().viewport.height), "Collapsed wheel must reach the last task");
  for (let index = 0; index < 80; index++) await wheel("up");
  check(scrollbox().scrollTop === 0, "Collapsed wheel must return to the first task");

  await rerender({ ...view, focused: true, width: 52, height: 46 });
  await settle(() => scrollbox().scrollTo(0));
  const selected = binding!.state.selectedId;
  const priorFrame = setup.captureCharFrame();
  const priorStyles = JSON.stringify(setup.captureSpans());
  services.focus.focusRegion("composer");
  const priorFocus = setup.renderer.currentFocusedRenderable;
  await click("plan-task-t2-title-0");
  check(binding!.state.selectedId === selected, "Clicking task title must not select the task or highlight its button");
  check(services.focus.activeContext() === "composer", "Clicking task title must not focus the pane");
  check(setup.renderer.currentFocusedRenderable === priorFocus, "Clicking a title must not move native keyboard focus");
  check(!setup.renderer.hasSelection, "Clicking a title must not start native text selection");
  await settle(() => setup.mockMouse.moveTo(0, 0));
  check(setup.captureCharFrame() === priorFrame, "Title clicks must leave button styling and contents unchanged");
  check(JSON.stringify(setup.captureSpans()) === priorStyles, "Title clicks must leave button colors unchanged");
  check(!/↑↓|Enter details|E\/C all/.test(setup.captureCharFrame()), "The task-pane keyboard hint must be removed");
  await capture("bordered-title-click");
  await click("plan-task-t2-disclosure");
  check(binding!.state.expanded.has("t2"), "The exact disclosure button must remain clickable");
  check(services.focus.activeContext() === "plan", "The disclosure button must focus the pane");
  services.focus.focusRegion("composer");
  const expandedState = binding!.state;
  await click("plan-task-t2-details");
  check(services.focus.activeContext() === "composer", "Clicking expanded task details must not focus the pane");
  check(setup.renderer.currentFocusedRenderable === priorFocus, "Clicking details must not move native keyboard focus");
  check(!setup.renderer.hasSelection, "Clicking details must not start native text selection");
  check(binding!.state === expandedState, "Clicking expanded details must leave selection and disclosure unchanged");

  await settle(() => interactionRef.current!.setAllExpanded(true));
  await rerender({ ...view, width: 48, height: 26 });
  await settle(() => scrollbox().scrollTo(0));
  const seen = new Set<string>();
  for (let index = 0; index < scrollbox().scrollHeight + 2; index++) {
    for (const match of viewportText().replace(/\s/g, "").matchAll(/Finding(t\d+:\d+)/g)) seen.add(match[1]!);
    if (scrollbox().scrollTop === Math.max(0, scrollbox().scrollHeight - scrollbox().viewport.height)) break;
    await wheel("down");
  }
  const missing = view.plan.tasks.flatMap((task) => Array.from({ length: 12 }, (_, index) => `${task.id}:${index + 1}`)).filter((id) => !seen.has(id));
  check(missing.length === 0, `All expanded findings must remain reachable, saw ${seen.size}/96, missing ${missing.join(", ")}`);
  await capture("bordered-expanded-bottom");

  for (const theme of ["dark", "light"] as const) {
    for (const [width, height] of [[52, 26], [34, 24], [24, 22], [18, 22], [48, 14]] as const) {
      await rerender({ ...view, width, height, theme });
      await settle(() => interactionRef.current!.setAllExpanded(false));
      await settle(() => scrollbox().scrollTo(0));
      inspectTitles();
      for (let index = 0; index < 14; index++) await wheel("down");
      for (let index = 0; index < 5; index++) {
        await settle(() => interactionRef.current!.page(index < 3 ? 1 : -1));
        inspectTitles();
      }
      await capture(`bordered-${theme}-${width}x${height}`);
      await settle(() => interactionRef.current!.moveSelection(-100));
      for (const task of view.plan.tasks) {
        const header = node(`plan-task-${task.id}-header`);
        const viewport = scrollbox().viewport;
        check(header.y >= viewport.y && header.y + Math.min(header.height, viewport.height) <= viewport.y + viewport.height, `Keyboard must reveal the selected title: ${width}x${height} ${task.id}`);
        inspectTitles();
        await settle(() => interactionRef.current!.moveSelection(1));
      }
      await settle(() => interactionRef.current!.setAllExpanded(true));
      for (let index = 0; index < 10; index++) await wheel("down");
    }
  }
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual([...clippedTitleEdges].sort(), ["bottom", "top"], "Native rendering must exercise partially visible titles at both viewport edges");
  console.log(JSON.stringify({ violations: [...violations] }, null, 2));
  assert.equal(violations.size, 0, "Native task viewport regressions must pass");
  console.log("Native task viewport passed: bordered geometry, visible title pixels at both edges, complete findings and button-only mouse interaction");
} finally {
  await act(async () => { setup.renderer.destroy(); });
  services.dispose();
}
