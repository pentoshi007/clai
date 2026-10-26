import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import stringWidth from "string-width";
import { act, createElement, createRef, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { RGBA, ScrollBoxRenderable, TextAttributes, TextRenderable, type Renderable } from "@opentui/core";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities, type ThemeHint } from "../../src/ui-core/bootstrap/capabilities.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";
import { createPlan, type SessionPlan } from "../../src/store/plan.js";
import { taskStateColor } from "../../src/ui-core/rendering/plan-view.js";
import { PlanView } from "../../src/tui-v2/components/plan/plan-view.js";
import type { PlanInteractionPort } from "../../src/tui-v2/components/plan/plan-interaction.js";

const services = createCompositionRoot({
  noHistory: true,
  provider: "openai",
  model: "test-model",
  persistence: {
    async saveSession() {},
    async loadPlan() { return undefined; },
    async savePlan() { throw new Error("Disclosure must not save the plan"); },
    async deletePlan() { throw new Error("Disclosure must not delete the plan"); },
  },
  capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: 52, rows: 40 }),
});
const plan = createPlan({ sessionId: services.session.sessionId, goal: "Reliable task disclosure", detail: "", taskTitles: ["Inspect the task contracts", "Verify the responsive controls", "No extra details"], kind: "ui" });
plan.status = "in_progress";
plan.tasks[0]!.note = "Unique finding alpha";
plan.tasks[0]!.state = "in_progress";
plan.tasks[1]!.note = "Unique finding beta";
plan.tasks[1]!.acceptanceCriteria = "Hidden acceptance field";
plan.tasks[1]!.resourceLocks = ["Hidden resource field"];
plan.tasks[2]!.acceptanceCriteria = "Hidden metadata field";
plan.tasks[2]!.evidence = { successWorkCount: 2, lastOkTool: "fs.read" };
const planBefore = JSON.stringify(plan);
const interactionRef = createRef<PlanInteractionPort>();
interface ViewState { plan: SessionPlan | undefined; width: number; theme: ThemeHint }
let view: ViewState = { plan, width: 52, theme: "dark" };
let updateView: (state: ViewState) => void = () => { throw new Error("View has not mounted"); };
let hideCalls = 0;
function Harness() {
  const [state, setState] = useState(view);
  updateView = setState;
  return createElement(PlanView, { theme: themeFor(state.theme), plan: state.plan, services, width: state.width, focused: true, interactionRef, onHide() { hideCalls += 1; } });
}
const setup = await testRender(createElement(Harness), { width: 52, height: 40, useThread: false });
async function settle(action: () => unknown = () => undefined): Promise<string> {
  await act(async () => { await action(); });
  await act(async () => { await setup.flush(); });
  const frame = setup.captureCharFrame();
  assert.doesNotMatch(frame, /\b(?:Expand|Collapse) all\b/);
  assert.equal(setup.renderer.root.findDescendantById("plan-expand-all"), undefined);
  assert.equal(setup.renderer.root.findDescendantById("plan-collapse-all"), undefined);
  return frame;
}
function node(id: string): Renderable {
  const value = setup.renderer.root.findDescendantById(id);
  assert.ok(value, `Missing native node ${id}`);
  return value;
}
async function click(id: string, button: 0 | 2 = 0): Promise<string> {
  const target = node(id);
  return settle(() => setup.mockMouse.click(target.x + Math.min(1, target.width - 1), target.y, button));
}
async function rerender(next: ViewState): Promise<string> {
  view = next;
  return settle(() => { updateView(next); setup.resize(next.width, 40); });
}
function assertContained(id: string): void {
  const target = node(id);
  assert.ok(target.x >= 0 && target.x + target.width <= view.width, `${id} overflowed ${view.width} columns`);
}
function assertInlineControl(id: string): void {
  const titleEnd = node(`plan-task-${id}-title-end`);
  const control = node(`plan-task-${id}-disclosure`);
  assert.equal(control.y, titleEnd.y, "Disclosure must stay on the final title line");
  assert.equal(control.x, titleEnd.x + titleEnd.width + 1, "Disclosure must directly follow the text with one separating space, not a right-aligned gap");
  assert.ok(titleEnd instanceof TextRenderable);
  assert.ok(titleEnd.plainText.slice(2).trim(), "The icon must share the final line with actual title text");
  assert.equal(control.width, 1);
  assert.equal(control.height, 1);
  const label = node(`plan-task-${id}-disclosure-label`);
  assert.ok(label instanceof TextRenderable);
  assert.match(label.plainText, /^[+−]$/, "Alignment must come from the button container, not padded label text");
  assert.equal(stringWidth(label.plainText), 1);
  assert.equal(label.width, 1);
  assert.equal(label.height, 1);
  assert.equal(label.x, titleEnd.x + stringWidth(titleEnd.plainText.trimEnd()) + 1, "Exactly one blank cell must separate the final title text and icon");
  assert.equal(label.y, titleEnd.y, "The glyph must align vertically with the last title line");
  assert.equal(label.x - control.x, control.x + control.width - label.x - label.width, "Horizontal inset must be symmetric");
  assert.equal(label.y - control.y, control.y + control.height - label.y - label.height, "Vertical inset must be symmetric");
  const line = setup.captureSpans().lines[control.y]!;
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let x = 0;
  let pixels = "";
  for (const span of line.spans) {
    for (const { segment } of graphemes.segment(span.text)) {
      if (x >= control.x && x < control.x + control.width) pixels += segment;
      x += stringWidth(segment);
    }
  }
  assert.equal(pixels, label.plainText, "The icon must occupy only its own terminal cell");
  assertContained(`plan-task-${id}-disclosure`);
}
function assertButtonStyle(id: string, highlighted: boolean): void {
  assertInlineControl(id);
  const control = node(`plan-task-${id}-disclosure`);
  const theme = themeFor(view.theme);
  const label = node(`plan-task-${id}-disclosure-label`);
  const line = setup.captureSpans().lines[control.y]!;
  const title = node(`plan-task-${id}-title-end`);
  assert.ok(title instanceof TextRenderable);
  const background = title.bg.toInts();
  let x = 0;
  let span: (typeof line.spans)[number] | undefined;
  for (const part of line.spans) {
    if (x < control.x + control.width && x + part.width > control.x) assert.deepEqual(part.bg.toInts(), background);
    if (label.x >= x && label.x < x + part.width) span = part;
    x += part.width;
  }
  assert.ok(span);
  assert.match(span.text.trim(), /^[+−]$/);
  assert.doesNotMatch(span.text, /[()]/);
  assert.deepEqual(span.fg.toInts(), RGBA.fromHex(highlighted ? theme.cyan : theme.foreground).toInts());
  assert.deepEqual(span.bg.toInts(), background, "Icons must never introduce a contrasting square background");
  assert.equal(span.attributes, TextAttributes.BOLD, "Buttons must not use underlines, including focus and hover");
}
function assertOriginalStyle(): void {
  const theme = themeFor(view.theme);
  const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
  const title = spans.find((span) => span.text.includes("Inspect the task contracts"));
  const note = spans.find((span) => span.text.includes("Unique finding alpha"));
  assert.ok(title);
  assert.ok(note);
  assert.deepEqual(title.fg.toInts(), RGBA.fromHex(theme.activity).toInts());
  assert.deepEqual(title.bg.toInts(), RGBA.fromHex(theme.rowA).toInts());
  assert.equal(title.attributes, TextAttributes.BOLD);
  assert.deepEqual(note.fg.toInts(), RGBA.fromHex(theme.muted).toInts());
  assert.deepEqual(note.bg.toInts(), RGBA.fromHex(theme.rowA).toInts());
  assert.equal(note.attributes, TextAttributes.DIM);
  assert.doesNotMatch(setup.captureCharFrame(), /\bNotes\b|\bDependencies\b|\bAcceptance\b|\bExecution\b|\bResources\b|\bDetails\b|Hidden .* field/);
}
async function capture(name: string): Promise<void> {
  const directory = process.env.CLAI_TEST_ARTIFACT_DIR;
  if (!directory) return;
  const data = { name, width: view.width, height: 40, frame: setup.captureCharFrame(), lines: setup.captureSpans().lines.map((line, y) => ({ y, spans: line.spans.map((span) => ({ text: span.text, width: span.width, fg: span.fg.toInts(), bg: span.bg.toInts(), attributes: span.attributes })) })) };
  await writeFile(join(directory, `${name}.json`), JSON.stringify(data));
}

try {
  let frame = await settle();
  assert.match(frame, /Inspect the task contracts/);
  assert.match(frame, /Verify the responsive controls/);
  assert.match(frame, /Inspect the task contracts \+ /, "Exactly one blank cell must separate the task title and bracketless icon");
  assert.doesNotMatch(frame, /Unique finding alpha/, "Task findings must be collapsed by default");
  assert.doesNotMatch(frame, /Unique finding beta/, "Task findings must be collapsed by default");
  node("plan-task-t1-disclosure");
  node("plan-hide");
  assert.equal(setup.renderer.root.findDescendantById("plan-task-t3-disclosure"), undefined);
  assertInlineControl("t1");
  assertInlineControl("t2");
  assertButtonStyle("t1", false);
  assertButtonStyle("t2", false);
  await click("plan-hide", 2);
  assert.equal(hideCalls, 0);
  await click("plan-hide");
  assert.equal(hideCalls, 1);
  await capture("tasks-dark-collapsed");
  const hoverTarget = node("plan-task-t2-disclosure");
  await settle(() => setup.mockMouse.moveTo(hoverTarget.x, hoverTarget.y));
  assertButtonStyle("t2", true);
  assert.equal(setup.renderer.root.findDescendantById("plan-task-t2-details"), undefined, "Hover must not expand a task");
  await capture("tasks-dark-hovered");
  await settle(() => setup.mockMouse.moveTo(0, 0));
  assertButtonStyle("t2", false);

  frame = await click("plan-task-t1-disclosure", 2);
  assert.doesNotMatch(frame, /Unique finding alpha/, "Secondary clicks must not toggle disclosure");
  frame = await click("plan-task-t1-disclosure");
  assert.match(frame, /Unique finding alpha/);
  assert.doesNotMatch(frame, /Unique finding beta/);
  node("plan-hide");
  assertContained("plan-hide");
  await settle(() => setup.mockMouse.moveTo(0, 0));
  assertButtonStyle("t1", false);
  await capture("tasks-dark-clicked-mouseout");
  await settle(() => interactionRef.current!.setSelectedExpanded(true));
  assertButtonStyle("t1", true);
  await capture("tasks-dark-keyboard-focused");
  await click("plan-task-t1-disclosure");
  await settle(() => setup.mockMouse.moveTo(0, 0));
  assertButtonStyle("t1", false);
  await click("plan-task-t1-disclosure");
  await settle(() => setup.mockMouse.moveTo(0, 0));
  assertButtonStyle("t1", false);
  await capture("tasks-dark-mixed");

  frame = await settle(() => interactionRef.current!.setAllExpanded(false));
  assert.doesNotMatch(frame, /Unique finding alpha|Unique finding beta/);
  assert.equal(setup.renderer.root.findDescendantById("plan-collapse-all"), undefined);
  frame = await settle(() => interactionRef.current!.setAllExpanded(true));
  assert.match(frame, /Unique finding alpha/);
  assert.match(frame, /Unique finding beta/);
  assert.equal(setup.renderer.root.findDescendantById("plan-expand-all"), undefined);
  assertOriginalStyle();
  assertInlineControl("t1");
  assertInlineControl("t2");
  await capture("tasks-dark-expanded");
  frame = await click("plan-task-t1-disclosure");
  assert.doesNotMatch(frame, /Unique finding alpha/);
  assert.match(frame, /Unique finding beta/);

  const updated: SessionPlan = { ...plan, updatedAt: "2026-10-11T19:00:01Z", tasks: [plan.tasks[1]!, plan.tasks[0]!, plan.tasks[2]!, { id: "c1", title: "Run independent proof", state: "in_progress", parentTaskId: "t1", responderOwned: true, note: "New child findings", jobId: "fixture-job", processId: 123 }] };
  updated.tasks[0] = { ...updated.tasks[0]!, note: "Unique finding beta · Refreshed findings" };
  frame = await rerender({ ...view, plan: updated });
  assert.match(frame, /Unique finding beta/);
  assert.match(frame, /Refreshed findings/);
  assert.doesNotMatch(frame, /New child findings/, "New tasks must start collapsed after expand-all");
  node("plan-task-c1-header");
  await settle(() => interactionRef.current!.setAllExpanded(true));
  await click("plan-task-t1-disclosure");
  assert.ok(setup.renderer.root.findDescendantById("plan-task-c1-details"), "Collapsing a parent must not hide child tasks or child details");
  assert.ok(node("plan-task-c1-header").y > node("plan-task-t1-header").y);

  const removed: SessionPlan = { ...updated, tasks: updated.tasks.filter((task) => task.id !== "t2"), updatedAt: "2026-10-11T19:00:02Z" };
  await rerender({ ...view, plan: removed });
  const reused: SessionPlan = { ...removed, tasks: [...removed.tasks, { id: "t2", title: "Replacement task", state: "pending", note: "Replacement findings" }] };
  frame = await rerender({ ...view, plan: reused });
  assert.doesNotMatch(frame, /Replacement findings/);

  const fresh: SessionPlan = { ...plan, createdAt: "2026-10-11T19:00:03Z", updatedAt: "2026-10-11T19:00:03Z" };
  frame = await rerender({ ...view, plan: fresh });
  assert.doesNotMatch(frame, /Unique finding alpha|Unique finding beta/);
  assert.equal(setup.renderer.root.findDescendantById("plan-collapse-all"), undefined);
  for (const width of [52, 34, 22, 18]) {
    await rerender({ ...view, width });
    await click("plan-task-t1-disclosure");
    assertInlineControl("t1");
    assertInlineControl("t2");
    assertContained("plan-hide");
    assert.ok(node("plan-tasks").height >= 1);
    assert.doesNotMatch(setup.captureCharFrame(), /\bDetails\b|\bNotes\b|Hidden .* field/);
    await capture(`tasks-dark-mixed-${width}`);
    await settle(() => interactionRef.current!.setAllExpanded(false));
  }

  frame = await rerender({ ...view, width: 52, theme: "light" });
  await capture("tasks-light-collapsed");
  frame = await settle(() => interactionRef.current!.setAllExpanded(true));
  assert.match(frame, /Unique finding alpha/);
  assert.match(frame, /Unique finding beta/);
  assertOriginalStyle();
  assertInlineControl("t1");
  assertButtonStyle("t1", true);
  assertButtonStyle("t2", false);
  const lightHoverTarget = node("plan-task-t2-disclosure");
  await settle(() => setup.mockMouse.moveTo(lightHoverTarget.x, lightHoverTarget.y));
  assertButtonStyle("t2", true);
  await capture("tasks-light-hovered");
  await settle(() => setup.mockMouse.moveTo(0, 0));
  assertButtonStyle("t2", false);
  await click("plan-task-t1-disclosure");
  await settle(() => setup.mockMouse.moveTo(0, 0));
  assertButtonStyle("t1", false);
  await click("plan-task-t1-disclosure");
  await settle(() => setup.mockMouse.moveTo(0, 0));
  assertButtonStyle("t1", false);
  await capture("tasks-light-clicked-mouseout");
  await settle(() => interactionRef.current!.moveSelection(1));
  assertButtonStyle("t1", false);
  assertButtonStyle("t2", true);
  await capture("tasks-light-keyboard-focused");
  await capture("tasks-light-expanded");

  for (const theme of ["dark", "light"] as const) {
    for (const width of [34, 22, 18]) {
      for (const title of ["123456789", "检查 👩🏽‍💻 long_identifier_without_spaces_0123456789"]) {
        const wrapped: SessionPlan = { ...fresh, tasks: [{ ...fresh.tasks[0]!, title }, fresh.tasks[1]!] };
        await rerender({ ...view, plan: wrapped, width, theme });
        assertInlineControl("t1");
      }
      await capture(`tasks-inline-${theme}-${width}`);
    }
  }

  for (const theme of ["dark", "light"] as const) {
    for (const state of ["pending", "in_progress", "done", "failed", "skipped"] as const) {
      const colors: SessionPlan = { ...fresh, tasks: [
        { ...fresh.tasks[0]!, title: "Background proof", state, responderOwned: true },
        { ...fresh.tasks[1]!, title: "Foreground proof", state },
      ] };
      await rerender({ ...view, plan: colors, width: 48, theme });
      const palette = themeFor(theme);
      const railColor = RGBA.fromHex(palette[taskStateColor(state)]).toInts();
      const titleColor = state === "pending" || state === "skipped" ? palette.foreground : palette[taskStateColor(state)];
      for (const id of ["t1", "t2"]) {
        const row = node(`plan-task-${id}`);
        const header = node(`plan-task-${id}-header`);
        for (const line of header.getChildren()) {
          const text = line.getChildren()[0];
          assert.ok(text instanceof TextRenderable);
          assert.deepEqual(text.fg.toInts(), RGBA.fromHex(titleColor).toInts(), `${id} must use its ${state} title color in ${theme} mode`);
        }
        let x = 0;
        const rail = setup.captureSpans().lines[header.y]!.spans.find((span) => {
          const contains = row.x >= x && row.x < x + span.width;
          x += span.width;
          return contains;
        });
        assert.ok(rail);
        assert.deepEqual(rail.bg.toInts(), railColor, `${id} must render its ${state} rail color in ${theme} mode`);
      }
      await capture(`tasks-status-${theme}-${state}`);
    }
  }

  const long: SessionPlan = { ...fresh, tasks: [{ ...fresh.tasks[0]!, title: "检查 👩🏽‍💻 long_identifier_without_spaces_0123456789", note: Array.from({ length: 50 }, (_, index) => `Finding line ${index + 1}`).join("\n") }, fresh.tasks[1]!] };
  await rerender({ ...view, plan: long, width: 34, theme: "dark" });
  const scroll = node("plan-tasks");
  assert.ok(scroll instanceof ScrollBoxRenderable);
  const beforePage = scroll.scrollTop;
  await settle(() => interactionRef.current!.page(1));
  assert.ok(scroll.scrollTop > beforePage);
  await settle(() => interactionRef.current!.page(-1));
  assert.equal(scroll.scrollTop, beforePage);
  const manualScroll = 8;
  await settle(() => scroll.scrollTo(manualScroll));
  const live: SessionPlan = { ...long, updatedAt: "2026-10-11T19:00:04Z", tasks: [{ ...long.tasks[0]!, note: `${long.tasks[0]!.note}\nLatest finding` }, long.tasks[1]!] };
  await rerender({ ...view, plan: live });
  assert.equal(scroll.scrollTop, manualScroll, "Live findings must not hijack manual reading position");
  await settle(() => interactionRef.current!.setAllExpanded(false));
  assert.ok(scroll.scrollTop >= 0 && scroll.scrollTop <= Math.max(0, scroll.scrollHeight - scroll.viewport.height));
  assertContained("plan-task-t1-disclosure");

  await rerender({ ...view, plan: undefined });
  assert.match(setup.captureCharFrame(), /No tasks yet/);
  await click("plan-hide");
  assert.equal(hideCalls, 2);
  frame = await rerender({ ...view, plan });
  assert.doesNotMatch(frame, /Unique finding alpha|Unique finding beta/);
  await rerender({ ...view, plan: { ...plan, tasks: [] } });
  assert.match(setup.captureCharFrame(), /0 tasks/);
  assert.equal(setup.renderer.root.findDescendantById("plan-expand-all"), undefined);
  assert.equal(setup.renderer.root.findDescendantById("plan-collapse-all"), undefined);
  assert.equal(JSON.stringify(plan), planBefore, "Disclosure must leave the plan object intact");
  console.log("Native task disclosure passed: defaults, individual/bulk controls, live updates, hierarchy, themes, widths, scrolling and empty states");
} finally {
  await act(async () => { setup.renderer.destroy(); });
  services.dispose();
}
