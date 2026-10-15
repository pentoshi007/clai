import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { act, createElement, createRef, useState } from "react";
import { LinearScrollAccel, ScrollBoxRenderable, TextRenderable, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities, type ThemeHint } from "../../src/ui-core/bootstrap/capabilities.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";
import { createPlan, type SessionPlan } from "../../src/store/plan.js";
import { PlanView } from "../../src/tui-v2/components/plan/plan-view.js";
import type { PlanInteractionPort } from "../../src/tui-v2/components/plan/plan-interaction.js";

const services = createCompositionRoot({
  noHistory: true,
  provider: "openai",
  model: "test-model",
  persistence: {
    async saveSession() {},
    async loadPlan() { return undefined; },
    async savePlan() { throw new Error("Scrolling must not save the plan"); },
    async deletePlan() { throw new Error("Scrolling must not delete the plan"); },
  },
  capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: 48, rows: 22 }),
});
const source = createPlan({ sessionId: services.session.sessionId, goal: "Reliable task scrolling", detail: "", kind: "ui", taskTitles: [
  "Verify task disclosure and ten-file reads end to end",
  "Restore original task styling with inline disclosure",
  "Keep every wrapped task title readable during scrolling",
  "Verify nested and responder task title wrapping",
  "Preserve the final task and all of its expanded findings",
] });
source.status = "completed";
for (const task of source.tasks) {
  task.state = "done";
  task.note = Array.from({ length: 20 }, (_, index) => `Finding ${task.id}:${index + 1} keeps the original evidence reachable.`).join("\n");
}
source.tasks[3] = { ...source.tasks[3]!, parentTaskId: "t3", responderOwned: true, jobId: "scroll-fixture", processId: 123 };
const before = JSON.stringify(source);
const interactionRef = createRef<PlanInteractionPort>();
interface ViewState { plan: SessionPlan; width: number; height: number; focused: boolean; theme: ThemeHint }
let view: ViewState = { plan: source, width: 48, height: 22, focused: false, theme: "dark" };
let updateView: (state: ViewState) => void = () => { throw new Error("View has not mounted"); };
function Harness() {
  const [state, setState] = useState(view);
  updateView = setState;
  return createElement(PlanView, { theme: themeFor(state.theme), plan: state.plan, services, width: state.width, focused: state.focused, interactionRef });
}
const setup = await testRender(createElement(Harness), { width: view.width, height: view.height, useThread: false });
async function settle(action: () => unknown = () => undefined): Promise<string> {
  await act(async () => { await action(); });
  await act(async () => { await setup.flush(); });
  return setup.captureCharFrame();
}
function node(id: string): Renderable {
  const value = setup.renderer.root.findDescendantById(id);
  assert.ok(value, `Missing native node ${id}`);
  return value;
}
function scrollbox(): ScrollBoxRenderable {
  const scroll = node("plan-tasks");
  assert.ok(scroll instanceof ScrollBoxRenderable);
  return scroll;
}
function assertVisibleTitles(): void {
  const scroll = scrollbox();
  for (const task of view.plan.tasks) {
    const row = node(`plan-task-${task.id}`);
    if (row.y >= scroll.viewport.y + scroll.viewport.height || row.y + row.height <= scroll.viewport.y) continue;
    const header = node(`plan-task-${task.id}-header`);
    for (const line of header.getChildren()) {
      const text = line.getChildren()[0];
      assert.ok(text instanceof TextRenderable);
      if (text.y < scroll.viewport.y || text.y >= scroll.viewport.y + scroll.viewport.height) continue;
      const rendered = Array.from(setup.captureCharFrame().split("\n")[text.y] ?? "").slice(text.x, text.x + text.width).join("");
      assert.equal(rendered, text.plainText, `Task ${task.id} must retain every visible title line at scrollTop=${scroll.scrollTop}`);
    }
  }
}
async function wheel(direction: "up" | "down"): Promise<void> {
  const scroll = scrollbox();
  await settle(() => setup.mockMouse.scroll(scroll.viewport.x + 3, scroll.viewport.y + 1, direction));
}
async function rerender(next: ViewState): Promise<void> {
  view = next;
  await settle(() => { updateView(next); setup.resize(next.width, next.height); });
}
async function capture(name: string): Promise<void> {
  const directory = process.env.CLAI_TEST_ARTIFACT_DIR;
  if (!directory) return;
  const scroll = scrollbox();
  const data = { name, width: view.width, height: view.height, scrollTop: scroll.scrollTop, viewport: { x: scroll.viewport.x, y: scroll.viewport.y, height: scroll.viewport.height }, frame: setup.captureCharFrame(), lines: setup.captureSpans().lines.map((line, y) => ({ y, spans: line.spans.map((span) => ({ text: span.text, width: span.width, fg: span.fg.toInts(), bg: span.bg.toInts(), attributes: span.attributes })) })) };
  await writeFile(join(directory, `${name}.json`), JSON.stringify(data));
}

try {
  await settle();
  scrollbox().scrollAcceleration = new LinearScrollAccel();
  assert.ok(node("plan-task-t1-header").height > 1, "The reported title must genuinely wrap");
  await capture("scroll-dark-initial");
  await wheel("down");
  await wheel("down");
  await capture("scroll-dark-first-wheel");
  assertVisibleTitles();
  for (let index = 0; index < 40; index++) {
    await wheel("down");
    assertVisibleTitles();
  }
  await capture("scroll-dark-collapsed-bottom");
  for (let index = 0; index < 40; index++) {
    await wheel("up");
    assertVisibleTitles();
  }
  assert.equal(scrollbox().scrollTop, 0, "Wheel scrolling must return to the beginning");

  await rerender({ ...view, focused: true });
  for (const task of view.plan.tasks) {
    const header = node(`plan-task-${task.id}-header`);
    const viewport = scrollbox().viewport;
    assert.ok(header.y >= viewport.y && header.y + header.height <= viewport.y + viewport.height, `Keyboard selection must reveal the entire ${task.id} title`);
    await settle(() => interactionRef.current!.moveSelection(1));
  }
  await capture("scroll-dark-selected-last");
  await settle(() => interactionRef.current!.moveSelection(-100));
  for (let index = 0; index < 6; index++) {
    await settle(() => interactionRef.current!.page(1));
    assertVisibleTitles();
  }
  for (let index = 0; index < 6; index++) {
    await settle(() => interactionRef.current!.page(-1));
    assertVisibleTitles();
  }
  assert.equal(scrollbox().scrollTop, 0, "PageUp must return to the beginning");

  await settle(() => interactionRef.current!.setAllExpanded(true));
  await settle(() => scrollbox().scrollTo(0));
  await capture("scroll-dark-expanded-top");
  const seenFindings = new Set<string>();
  for (let index = 0; index < scrollbox().scrollHeight + 5; index++) {
    for (const match of setup.captureCharFrame().replace(/\s/g, "").matchAll(/Finding(t\d+:\d+)/g)) seenFindings.add(match[1]!);
    const position = scrollbox().scrollTop;
    await wheel("down");
    assertVisibleTitles();
    if (scrollbox().scrollTop === position) break;
  }
  await capture("scroll-dark-expanded-bottom");
  assert.equal(seenFindings.size, 100, `Expanded finding coverage stopped at offset ${scrollbox().scrollTop}/${scrollbox().scrollHeight}, saw ${[...seenFindings].join(",")}`);
  for (const task of view.plan.tasks) {
    for (let index = 1; index <= 20; index++) assert.ok(seenFindings.has(`${task.id}:${index}`), `Expanded finding ${task.id}:${index} must remain reachable`);
  }
  await settle(() => scrollbox().scrollTo(8));
  const readingPosition = scrollbox().scrollTop;
  const readingFrame = setup.captureCharFrame();
  const live: SessionPlan = { ...source, updatedAt: "2026-10-12T06:00:01Z", tasks: source.tasks.map((task, index) => index === 0 ? { ...task, note: `${task.note}\nLatest appended finding` } : task) };
  await rerender({ ...view, plan: live });
  assert.equal(scrollbox().scrollTop, readingPosition, "Appended findings must not hijack reading position");
  assert.equal(setup.captureCharFrame(), readingFrame, "Appending below the viewport must leave visible findings unchanged");
  const running: SessionPlan = { ...live, status: "in_progress", updatedAt: "2026-10-12T06:00:02Z", tasks: live.tasks.map((task, index) => index === 1 ? { ...task, state: "in_progress" } : task) };
  await rerender({ ...view, plan: running });
  assert.equal(scrollbox().scrollTop, readingPosition, "Unrelated task progress must not reveal an already-selected title while reading findings");
  await capture("scroll-dark-live-findings");

  for (const theme of ["dark", "light"] as const) {
    for (const [width, height] of [[48, 22], [34, 18], [24, 18], [18, 20], [48, 12], [24, 16]] as const) {
      await rerender({ ...view, width, height, theme });
      for (let index = 0; index < 12; index++) {
        await wheel("down");
        assertVisibleTitles();
      }
      await capture(`scroll-${theme}-expanded-${width}x${height}`);
      await settle(() => interactionRef.current!.setAllExpanded(false));
      assertVisibleTitles();
      for (let index = 0; index < 8; index++) {
        await settle(() => interactionRef.current!.page(index < 4 ? 1 : -1));
        assertVisibleTitles();
      }
      await capture(`scroll-${theme}-collapsed-${width}x${height}`);
      await settle(() => interactionRef.current!.setAllExpanded(true));
    }
  }
  assert.equal(JSON.stringify(source), before, "Scrolling must leave the plan intact");
  console.log("Native task scrolling passed: wrapped-title wheel boundaries, complete keyboard titles, paging, expanded findings, hierarchy, live updates, themes and short/narrow viewports");
} finally {
  await act(async () => { setup.renderer.destroy(); });
  services.dispose();
}
