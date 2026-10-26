import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { act, createElement } from "react";
import { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { App } from "../../src/tui-v2/app/App.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { layoutPickerOptions } from "../../src/ui-core/rendering/picker-layout.js";
import type { PickerOption } from "../../src/ui-core/rendering/picker-filter.js";
import { transcriptScrollPort } from "../../src/tui-v2/components/transcript/transcript-scroll-port.js";
import { EventSequencer, createCountingIdFactory } from "../../src/app/events/sequencer.js";
import { asMessageId, asSessionId, asTurnId } from "../../src/app/events/app-event.js";

const services = createCompositionRoot({
  noHistory: true,
  provider: "openai",
  model: "test-model",
  persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: 90, rows: 28 }),
});
const seq = new EventSequencer(asSessionId("history-navigation"), createCountingIdFactory("history-nav"));
for (let index = 0; index < 60; index += 1) {
  services.transcript.dispatch(seq.build("assistant-message", {
    messageId: asMessageId(`message-${index}`), text: `Transcript message ${index}\n${"Background content\n".repeat(4)}`,
  }, asTurnId("history-navigation-turn")));
}
const options: PickerOption[] = Array.from({ length: 200 }, (_, index) => ({
  value: `session-${index}`,
  label: `Session ${String(index).padStart(3, "0")}`,
  description: `id session-${index} · ${index} items${index % 3 === 2 ? "\nMore session details" : ""}`,
  active: index === 0,
}));
const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), {
  width: 90, height: 28, kittyKeyboard: true, useMouse: true, useThread: false,
});
const failures = new Set<string>();
function captureEvidence() {
  return setup.captureSpans().lines.map((line) => line.spans.map((span) => ({
    text: span.text, width: span.width, fg: span.fg.toInts(), bg: span.bg.toInts(),
  })));
}
const evidence: ReturnType<typeof captureEvidence>[] = [];
let chosen: string | undefined;
const check = (condition: boolean, message: string): void => { if (!condition) failures.add(message); };
async function settle(action: () => unknown = () => undefined): Promise<void> {
  await act(async () => {
    await action();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await act(async () => { await setup.flush(); });
}
function picker(): ScrollBoxRenderable {
  const value = setup.renderer.root.findDescendantById("picker-options");
  assert.ok(value instanceof ScrollBoxRenderable);
  return value;
}
function selectedIndex(): number {
  const row = setup.captureCharFrame().split("\n").find((line) => line.includes("❯"));
  const label = row?.match(/Session (\d+)/);
  return label ? Number(label[1]) : -1;
}
function layout() {
  return layoutPickerOptions(options, picker().viewport.width, true);
}
function assertSelected(expected: number, context: string): void {
  check(selectedIndex() === expected, `${context}: expected Session ${expected}, got ${selectedIndex()}`);
  const item = layout()[expected]!;
  const box = picker();
  if (item.height <= box.viewport.height) {
    check(item.top >= box.scrollTop && item.top + item.height <= box.scrollTop + box.viewport.height,
      `${context}: selected session is not fully visible`);
  }
}
async function open(source: readonly PickerOption[] = options): Promise<void> {
  await settle(() => services.overlay.close());
  await settle(() => setup.mockMouse.moveTo(0, 0));
  chosen = undefined;
  await settle(() => services.overlay.openPicker({ title: "History", historyStyle: true, twoLine: true, options: source }, (value) => {
    chosen = value;
    services.overlay.close();
  }));
}
function emitArrow(direction: "up" | "down", eventType: "press" | "repeat" | "release" = "press"): void {
  const sequence = direction === "up" ? "\x1b[A" : "\x1b[B";
  const event = new KeyEvent({
    name: direction, ctrl: false, meta: false, shift: false, option: false,
    number: false, sequence, raw: sequence, source: "kitty", eventType,
  });
  setup.renderer.keyInput.emit(eventType === "release" ? "keyrelease" : "keypress", event);
}
try {
  await settle();
  await settle(() => services.focus.focusRegion("transcript"));
  await settle(() => transcriptScrollPort.scrollToTop());
  await settle(() => transcriptScrollPort.scrollBy(12));
  const background = { ...transcriptScrollPort.metrics };
  const sessionId = services.session.sessionId;

  await open();
  for (let index = 1; index <= 30; index += 1) {
    const before = picker().scrollTop;
    const item = layout()[index]!;
    const expectedTop = Math.max(before, item.top + item.height - picker().viewport.height);
    await settle(() => setup.mockInput.pressArrow("down"));
    assertSelected(index, "down navigation");
    check(picker().scrollTop === expectedTop, "down navigation must not snap each session to the viewport top");
  }
  evidence.push(captureEvidence());
  for (let index = 29; index >= 0; index -= 1) {
    const expectedTop = Math.min(picker().scrollTop, layout()[index]!.top);
    await settle(() => setup.mockInput.pressArrow("up"));
    assertSelected(index, "up navigation");
    check(picker().scrollTop === expectedTop, "up navigation must scroll only when selection leaves the viewport");
  }
  check(JSON.stringify(transcriptScrollPort.metrics) === JSON.stringify(background), "picker arrows must not scroll the background transcript");
  check(services.session.sessionId === sessionId, "picker arrows must not resume another session");

  await open();
  await settle(() => { for (let index = 0; index < 8; index += 1) emitArrow("down", index === 0 ? "press" : "repeat"); });
  assertSelected(8, "batched key repeats");
  await settle(() => emitArrow("down", "release"));
  assertSelected(8, "key release");
  await settle(() => {
    emitArrow("down");
    emitArrow("down", "repeat");
    setup.mockInput.pressEnter();
  });
  check(chosen === "session-10", `enter in a key burst must choose the latest selection, got ${chosen}`);

  await open();
  const viewport = picker().viewport;
  const hoverIndex = 3;
  await settle(() => setup.mockMouse.moveTo(viewport.x + 8, viewport.y + layout()[hoverIndex]!.top));
  assertSelected(hoverIndex, "mouse selection");
  for (let index = hoverIndex + 1; index <= hoverIndex + 12; index += 1) {
    await settle(() => setup.mockInput.pressArrow("down"));
    assertSelected(index, "keyboard navigation under a stationary pointer");
  }
  evidence.push(captureEvidence());
  const mouseTarget = layout()[14]!;
  await settle(() => setup.mockMouse.moveTo(viewport.x + 10, viewport.y + mouseTarget.top - picker().scrollTop));
  assertSelected(14, "mouse navigation resumes after keyboard input");
  await settle(() => setup.mockInput.pressArrow("up"));
  assertSelected(13, "keyboard navigation resumes from the mouse selection");

  await open();
  const wheelBox = picker();
  await settle(() => setup.mockMouse.scroll(wheelBox.viewport.x + 5, wheelBox.viewport.y + 4, "down"));
  check(picker().scrollTop > 0, "wheel input must scroll history");
  check(JSON.stringify(transcriptScrollPort.metrics) === JSON.stringify(background), "history wheel input must not scroll the background transcript");
  await settle(() => setup.mockInput.pressKey("HOME"));
  assertSelected(0, "home after scrolling with the first option selected");
  await settle(() => setup.mockInput.pressKey("END"));
  assertSelected(199, "end");
  await settle(() => setup.mockInput.pressArrow("down"));
  assertSelected(0, "wrap down");
  await settle(() => setup.mockInput.pressArrow("up"));
  assertSelected(199, "wrap up");
  await settle(() => setup.mockInput.pressKey("HOME"));
  assertSelected(0, "home");
  await settle(() => setup.mockInput.pressKey("\x1b[6~"));
  check(picker().scrollTop > 0 && selectedIndex() > 0, "page down must move within the history picker");
  await settle(() => setup.mockInput.pressKey("\x1b[5~"));
  assertSelected(0, "page up");

  await settle(() => setup.mockInput.typeText("Session 019"));
  check(selectedIndex() === 19, "filter must select the matching session");
  await settle(() => setup.mockInput.pressKey("u", { ctrl: true }));
  assertSelected(0, "clear filter");
  await settle(() => setup.mockInput.typeText("zzzzzz"));
  check(setup.captureCharFrame().includes("no matches"), "empty filter must show no matches");
  await settle(() => setup.mockInput.pressArrow("down"));
  await settle(() => setup.mockInput.pressEnter());
  check(services.overlay.getState().kind === "picker", "enter on no matches must not resume a session");
  await settle(() => setup.mockInput.pressEscape());
  check(services.overlay.getState().kind === "none", "escape closes the picker");
  check(services.focus.activeContext() === "transcript", "escape restores transcript focus");
  check(JSON.stringify(transcriptScrollPort.metrics) === JSON.stringify(background), "picker navigation and filtering must preserve transcript position");

  for (const [width, height] of [[40, 14], [24, 10], [90, 28]]) {
    await settle(() => setup.resize(width!, height!));
    await open();
    for (let index = 1; index <= 5; index += 1) {
      await settle(() => setup.mockInput.pressArrow("down"));
      assertSelected(index, `${width}x${height} navigation`);
    }
    evidence.push(captureEvidence());
    for (let index = 4; index >= 0; index -= 1) {
      await settle(() => setup.mockInput.pressArrow("up"));
      assertSelected(index, `${width}x${height} reverse navigation`);
    }
  }
  await open(options.map((option, index) => ({ ...option, active: index === 50 })));
  assertSelected(50, "initial active session");
  await settle(() => setup.mockInput.pressArrow("up"));
  assertSelected(49, "navigation from the active session");
  await open([{ value: "only", label: "Session 000", description: "Only session" }]);
  await settle(() => { emitArrow("down"); emitArrow("up"); });
  check(selectedIndex() === 0 && picker().scrollTop === 0, "single-option navigation must remain stable");
  await open([{ value: "tall", label: "Session 000", description: "Long session details\n".repeat(200) }]);
  await settle(() => setup.mockInput.pressKey("\x1b[6~"));
  check(picker().scrollTop > 0, "page down must expose an oversized session's full details");
  await settle(() => setup.mockInput.pressKey("HOME"));
  check(picker().scrollTop === 0 && selectedIndex() === 0, "home must return to an oversized session's label");
  await open([
    options[0]!,
    { value: "tall", label: "Session 001", description: "Long session details\n".repeat(200) },
    options[2]!,
  ]);
  await settle(() => setup.mockInput.pressKey("END"));
  await settle(() => setup.mockInput.pressArrow("up"));
  check(selectedIndex() === 1, "moving up into an oversized session must reveal its selection marker");
  const artifact = process.env.CLAI_HISTORY_NAV_CAPTURE;
  if (artifact) await writeFile(artifact, JSON.stringify(evidence));
  assert.deepEqual([...failures], []);
} finally {
  await act(async () => { services.dispose(); setup.renderer.destroy(); });
}
console.log("Native history navigation passed");
