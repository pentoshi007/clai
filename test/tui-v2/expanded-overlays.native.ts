import assert from "node:assert/strict";
import { act, createElement } from "react";
import { writeFile } from "node:fs/promises";
import { testRender } from "@opentui/react/test-utils";
import { RGBA, ScrollBoxRenderable, type Renderable } from "@opentui/core";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { attachCommandHandlers } from "../../src/ui-core/commands/command-handlers.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { App } from "../../src/tui-v2/app/App.js";
import { overlaySize } from "../../src/ui-core/layout/overlay-size.js";
import { layoutPickerOptions } from "../../src/ui-core/rendering/picker-layout.js";
import { centerChromeRow, wrapPagerLine } from "../../src/ui-core/rendering/pager-chrome.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";

const services = createCompositionRoot({
  noHistory: true,
  provider: "openai",
  model: "test-model",
  persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: 120, rows: 40 }),
});
attachCommandHandlers(services);
const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), { width: 120, height: 40, kittyKeyboard: true, useThread: false });
const settle = async (action: () => unknown = () => undefined, waitMs = 80): Promise<string> => {
  await act(async () => {
    await action();
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  });
  await act(async () => { await setup.flush(); });
  return setup.captureCharFrame();
};
const evidence: string[] = [];
const assertPickerTitle = (title: string, width: number): void => {
  const heading = setup.renderer.root.findDescendantById("picker-title");
  assert.ok(heading);
  assert.equal(heading.width, width);
  const row = setup.captureSpans().lines[heading.y]!;
  const text = row.spans.map((span) => span.text).join("");
  assert.equal(text.slice(heading.x, heading.x + width), centerChromeRow(title, width));
  const background = RGBA.fromHex(themeFor(services.capabilities.themeHint).chipIndigo);
  const cells = row.spans.flatMap((span) => Array.from({ length: span.width }, () => span.bg));
  assert.ok(cells.slice(heading.x, heading.x + width).every((color) => color.equals(background)));
};
const pickerScrollBox = (): ScrollBoxRenderable => {
  const box = setup.renderer.root.findDescendantById("picker-options");
  assert.ok(box instanceof ScrollBoxRenderable);
  return box;
};
const countNodes = (node: Renderable): number => 1 + node.getChildren().reduce((sum, child) => sum + countNodes(child), 0);
const assertBoundedPicker = (): void => {
  const box = pickerScrollBox();
  const nodes = box.content.getChildren().reduce((sum, child) => sum + countNodes(child), 0);
  assert.ok(nodes <= 2 * (box.viewport.height + 4) + 2, `${nodes} native nodes for ${box.viewport.height} visible rows`);
};
const assertNoticeOutsidePane = async (height: number, marginY: number): Promise<void> => {
  const pane = (frame: string): string => frame.split("\n").slice(marginY, height - marginY).join("\n");
  const before = pane(setup.captureCharFrame());
  const after = await settle(() => services.toast.info("Background status update ".repeat(20), { key: "overlay-notice" }));
  assert.equal(pane(after), before, "notifications must not cover the picker or pager body");
};
try {
  await setup.flush();
  for (const [width, height] of [[120, 40], [40, 20], [24, 10], [8, 4]]) {
    await settle(() => setup.resize(width!, height!));
    const picker = await settle(() => services.commands.dispatch({ name: "orchastrator" }));
    const size = overlaySize(width!, height!);
    if (width! >= 24) {
      assert.match(picker, /Status/);
      const overlay = services.overlay.getState();
      assert.equal(overlay.kind, "picker");
      if (overlay.kind === "picker") assertPickerTitle(overlay.request.title, size.width - 2);
      const border = picker.split("\n").findIndex((row) => row.includes("╭"));
      assert.equal(border, size.marginY, picker);
      assert.equal(picker.split("\n")[border]!.indexOf("╭"), size.marginX, picker);
      assert.equal(picker.split("\n").filter((row) => row.includes("│")).length, size.height - 2, picker);
    }
    assert.equal(services.session.subagents.enabled, false);
    await settle(() => setup.mockInput.pressEnter());
    assert.equal(services.session.subagents.enabled, false);
    assert.equal(services.overlay.getState().kind, "none");
    await settle(() => services.commands.dispatch({ name: "orchestrator" }));
    await settle(() => setup.mockInput.pressArrow("down"));
    await settle(() => setup.mockInput.pressEnter());
    assert.equal(services.session.subagents.enabled, true);
    await settle(() => services.commands.dispatch({ name: "orchestrator", args: "off" }));
    await settle(() => services.toast.clear());

    let selected = "";
    const options = [{ value: "full", label: `rg --files ${"directory/".repeat(12)} --glob '*.ts'`, description: "Description with every word retained. ".repeat(10) + "END" }];
    await settle(() => services.overlay.openPicker({
      title: "Complete command",
      twoLine: true,
      options,
    }, (value) => { selected = value; services.overlay.close(); }));
    if (height! >= 10) assertPickerTitle("Complete command", size.width - 2);
    await assertNoticeOutsidePane(height!, size.marginY);
    const lines = layoutPickerOptions(options, size.width - 2, true)[0]!.lines;
    const frames = [setup.captureCharFrame()];
    assertBoundedPicker();
    for (let i = 0; i <= lines.length && !lines.every((line) => frames.some((frame) => frame.includes(line.text))); i++) {
      const frame = await settle(() => setup.mockInput.pressKey("\x1b[6~"), 5);
      frames.push(frame);
      assertBoundedPicker();
    }
    for (const line of lines) assert.ok(frames.some((frame) => frame.includes(line.text)), `${width}×${height} missing wrapped text: ${line.text}\n${frames.at(-1)}`);
    await settle(() => setup.mockInput.pressEnter());
    assert.equal(selected, "full");
    const command = `curl --request GET https://example.test/${"complete-path/".repeat(20)}?final=END`;
    const pager = await settle(() => services.overlay.openPager("Output", command, undefined, undefined, "plain"));
    await assertNoticeOutsidePane(height!, size.marginY);
    const commandLines = wrapPagerLine(command, Math.max(1, size.width - 4), { preserveWhitespace: true });
    const pagerFrames = [pager];
    for (let i = 0; i <= commandLines.length && !commandLines.every((line) => pagerFrames.some((frame) => frame.includes(line))); i++) {
      pagerFrames.push(await settle(() => setup.mockInput.pressKey("\x1b[6~"), 5));
    }
    for (const line of commandLines) assert.ok(pagerFrames.some((frame) => frame.includes(line)), `${width}×${height} missing command text: ${line}`);
    if (width! >= 100) {
      assert.equal((pager.match(/c:copy/g) ?? []).length, 1, pager);
      assert.equal((pager.match(/f:format/g) ?? []).length, 1, pager);
      assert.equal((pager.match(/r:raw/g) ?? []).length, 1, pager);
      evidence.push(picker, pager);
    }
    await settle(() => setup.mockInput.pressKey("\x1b[F"));
    if (width! >= 24) assert.match(setup.captureCharFrame(), /END/, setup.captureCharFrame());
    await settle(() => setup.mockInput.pressEscape());
    assert.equal(services.overlay.getState().kind, "none");
  }
  await settle(() => setup.resize(120, 40));
  await settle(() => services.overlay.openPager("Searchable", "alpha line\nbeta line\ngamma line", undefined, undefined, "plain"));
  assert.equal(services.focus.activeContext(), "pager");
  const searchBarFrame = await settle(() => setup.mockInput.pressKey("r", { ctrl: true }));
  assert.match(searchBarFrame, /\^R/, "ctrl+r must open the pager search bar while the pager overlay is active");
  assert.equal(services.focus.activeContext(), "pager", "transcript search must not steal ctrl+r from the pager");
  for (const char of "beta") await settle(() => setup.mockInput.pressKey(char), 5);
  const afterSubmit = await settle(() => setup.mockInput.pressEnter());
  assert.doesNotMatch(afterSubmit, / \^R /, "submitting the query closes the pager search bar");
  await settle(() => setup.mockInput.pressKey("r", { ctrl: true }));
  const afterEscape = await settle(() => setup.mockInput.pressEscape());
  assert.doesNotMatch(afterEscape, / \^R /, "escape closes the pager search bar");
  await settle(() => setup.mockInput.pressEscape());
  assert.equal(services.overlay.getState().kind, "none");
  for (const title of ["History", "Models · openai · live", "Providers", "Reasoning effort"]) {
    await settle(() => services.overlay.openPicker({
      title,
      historyStyle: title === "History",
      options: [{ value: "one", label: "First option" }],
    }, () => services.overlay.close()));
    assertPickerTitle(title, overlaySize(120, 40).width - 2);
    evidence.push(setup.captureCharFrame());
    await settle(() => services.overlay.close());
  }
  const largeOptions = Array.from({ length: 10000 }, (_, index) => ({
    value: String(index), label: `Option ${index}`, description: `Description ${index}\nFull details ${index}`,
  }));
  await settle(() => services.overlay.openPicker({ title: "Large list", twoLine: true, options: largeOptions }, () => services.overlay.close()));
  assert.equal(pickerScrollBox().scrollHeight, 30000);
  assertBoundedPicker();
  assert.match(await settle(() => setup.mockInput.pressKey("\x1b[F")), /Option 9999/);
  assertBoundedPicker();
  assert.match(await settle(() => setup.mockInput.pressKey("\x1b[H")), /Option 0/);
  await settle(() => setup.mockInput.pressKey("\x1b[6~"));
  assert.ok(pickerScrollBox().scrollTop > 0);
  assertBoundedPicker();
  assert.match(await settle(() => pickerScrollBox().scrollTo(15000)), /Option 5000/);
  assertBoundedPicker();
  const beforeWheel = pickerScrollBox().scrollTop;
  await settle(() => setup.mockMouse.scroll(10, 10, "down"));
  assert.ok(pickerScrollBox().scrollTop > beforeWheel);
  assertBoundedPicker();
  await settle(() => setup.resize(24, 10));
  assertBoundedPicker();
  await settle(() => setup.mockInput.pressKey("z"));
  assert.match(setup.captureCharFrame(), /no matches/);
  assertBoundedPicker();
  await settle(() => setup.mockInput.pressKey("\x15"));
  assertBoundedPicker();
  await settle(() => services.overlay.close());

  await settle(() => setup.resize(80, 16));
  let tallSelected = false;
  await settle(() => services.overlay.openPicker({
    title: "Tall option", twoLine: true,
    options: [{ value: "tall", label: "One option", description: Array.from({ length: 10000 }, (_, index) => `Detail ${index}`).join("\n") + "\nLAST DETAIL" }],
  }, () => { tallSelected = true; services.overlay.close(); }));
  assertBoundedPicker();
  assert.match(await settle(() => pickerScrollBox().scrollTo(5000)), /Detail 4999/);
  assertBoundedPicker();
  assert.match(await settle(() => pickerScrollBox().scrollTo(pickerScrollBox().scrollHeight)), /LAST DETAIL/);
  assertBoundedPicker();
  await settle(() => setup.mockInput.pressEnter());
  assert.equal(tallSelected, true);

  await settle(() => setup.resize(120, 40));
  const slashMenu = await settle(() => setup.mockInput.pressKey("/"));
  assert.equal(services.overlay.getState().kind, "none");
  assert.match(slashMenu, /commands ·/);
  const slashRows = slashMenu.split("\n");
  const menuTop = slashRows.findIndex((line) => line.includes("commands ·"));
  const menuBottom = slashRows.findIndex((line, index) => index > menuTop && line.includes("╰"));
  assert.ok(menuTop > 1 && menuBottom > menuTop && menuBottom - menuTop < 20, slashMenu);
  if (process.env.CLAI_OVERLAY_EVIDENCE) await writeFile(process.env.CLAI_OVERLAY_EVIDENCE, evidence.join("\n\n"));
  console.log("Native expanded overlays passed: geometry, wrapping, scrolling, hints, and orchestration opt-in");
} finally {
  await act(async () => { services.dispose(); setup.renderer.destroy(); });
  await setup.renderer.idle();
}
