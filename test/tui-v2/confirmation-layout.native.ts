import assert from "node:assert/strict";
import { act, createElement } from "react";
import { writeFile } from "node:fs/promises";
import { testRender } from "@opentui/react/test-utils";
import { TextareaRenderable, type Renderable } from "@opentui/core";
import { App } from "../../src/tui-v2/app/App.js";
import { ToolCard } from "../../src/tui-v2/components/transcript/tool-card.js";
import { TerminalDimensionsContext } from "../../src/tui-v2/hooks/terminal-dimensions.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";
import { createOverlayConfirmPort } from "../../src/ui-core/bootstrap/overlay-ports.js";
import { confirmToolExecution } from "../../src/agent/confirm-port.js";
import { createSessionPolicy } from "../../src/agent/session-policy.js";
import { updateConfig } from "../../src/store/config.js";
import { asToolCallId } from "../../src/app/events/app-event.js";
import type { ToolItem } from "../../src/ui-core/state/transcript-types.js";
import { composerActionPort } from "../../src/ui-core/composer/composer-action-port.js";

updateConfig({ permissions: "allow-all" });
const services = createCompositionRoot({
  noHistory: true, provider: "openai", model: "test-model",
  persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: 120, rows: 40 }),
});
const theme = themeFor(services.capabilities.themeHint);
const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), {
  width: 120, height: 40, kittyKeyboard: true, useThread: false,
});
const settle = async (action: () => unknown = () => undefined): Promise<string> => {
  await act(async () => { action(); await new Promise((resolve) => setTimeout(resolve, 40)); });
  await act(async () => { await setup.flush(); });
  return setup.captureCharFrame();
};
const descendants = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(descendants)];
const evidence: string[] = [];
const command = `sh -c 'rm "$TARGET"\n${Array.from({ length: 400 }, (_, i) => `  printf "line ${i}\\n"`).join("\n")}\n  printf "LAST_COMMAND_LINE\\n"'`;
const port = createOverlayConfirmPort(services.overlay);
try {
  for (const [width, height] of [[120, 40], [80, 24], [80, 16], [40, 12], [24, 10], [160, 48]]) {
    await settle(() => setup.resize(width!, height!));
    if (width === 80 && height === 16) await settle(() => composerActionPort.insert("draft line\n".repeat(40)));
    let answer!: Promise<boolean>;
    const frame = await settle(() => {
      answer = confirmToolExecution({ name: "shell.exec", args: { command } }, true, createSessionPolicy(), port);
    });
    const modal = setup.renderer.root.findDescendantById("confirm-modal");
    const actions = setup.renderer.root.findDescendantById("confirm-actions");
    const composer = descendants(setup.renderer.root).find((node) => node instanceof TextareaRenderable);
    assert.ok(modal && actions && composer, frame);
    assert.ok(modal.y >= 0 && modal.y + modal.height <= height! - 4, `${width}×${height} modal covers composer\n${frame}`);
    assert.ok(actions.y >= modal.y && actions.y < modal.y + modal.height - 1, frame);
    assert.ok(composer.y >= modal.y + modal.height && composer.y + composer.height <= height! - 1, frame);
    assert.match(frame, /Reason:/);
    assert.match(frame, /y approve|y\/n/);
    assert.match(frame, /n deny|esc deny|y\/n/);
    assert.match(frame, /ctrl\+o|\^O/);
    if (width! >= 80) {
      assert.match(frame, /Auto-allow/);
      assert.match(frame, /Run shell.exec/);
      assert.match(frame, /more lines/);
    }
    evidence.push(`${width}×${height}\n${frame}`);
    if (width === 120) {
      const resized = await settle(() => setup.resize(40, 12));
      assert.match(resized, /Reason:/);
      assert.match(resized, /y\/n/);
      assert.match(resized, /ctrl\+o|\^O/);
      assert.equal(services.overlay.getState().kind, "confirm");
      await settle(() => setup.resize(width!, height!));
    }
    await settle(() => setup.mockInput.pressKey("o", { ctrl: true }));
    const review = services.overlay.getState();
    assert.equal(review.kind, "pager");
    if (review.kind === "pager") {
      assert.ok(review.body.includes(command));
      assert.match(review.body, /Reason: Auto-allow/);
      assert.match(review.body, /LAST_COMMAND_LINE/);
    }
    await settle(() => setup.mockInput.pressKey("\x1b[6~"));
    await settle(() => setup.mockInput.pressEscape());
    assert.equal(services.overlay.getState().kind, "confirm");
    await settle(() => width === 160 ? setup.mockInput.pressKey("y") : setup.mockInput.pressKey("n"));
    assert.equal(await answer, width === 160);
    assert.equal(services.overlay.getState().kind, "none");
    await settle(() => composerActionPort.clear());
  }
} finally {
  await act(async () => { setup.renderer.destroy(); });
  await setup.renderer.idle();
}

for (const mode of ["running", "ok", "failed", "queued", "blocked", "batch", "output"] as const) {
  const batch = mode === "batch";
  const item: ToolItem = {
    id: `tool-${mode}`, sequence: 1, turnId: undefined, timestamp: Date.now() - 3000,
    kind: "tool", toolCallId: asToolCallId(`call-${mode}`), name: batch ? "tool.batch" : "shell.exec", argsDisplay: "test command",
    status: mode === "batch" || mode === "output" ? "running" : mode,
    exitCode: mode === "failed" ? 127 : undefined, summary: undefined, artifactPath: undefined, reason: undefined,
    outputBytes: 0, fileChanges: undefined,
  };
  if (batch) services.session.spool.replace(item.toolCallId, "[batch] #1 shell.exec starting\n── #2 shell.exec [fail exit=127]\ncommand missing\n── #3 shell.exec [ok exit=0]\nactual output");
  if (mode === "output") services.session.spool.replace(item.toolCallId, "actual command output: running failed done");
  const card = await testRender(createElement(ServicesProvider, { services, children:
    createElement(TerminalDimensionsContext.Provider, { value: { width: 120, height: 40 }, children:
      createElement(ToolCard, { item, theme, spool: services.session.spool, expanded: true, services, onToggle() {}, contentWidth: 116 }),
    }),
  }), { width: 120, height: 40, useThread: false });
  try {
    await act(async () => { await card.flush(); });
    const frame = card.captureCharFrame();
    if (mode === "output") assert.match(frame, /actual command output: running failed done/);
    else assert.doesNotMatch(frame, /\b(running|failed|done)\b/);
    if (mode === "failed") { assert.match(frame, /127 · not found/); assert.match(frame, /✗/); }
    if (mode === "queued" || mode === "blocked") assert.ok(frame.includes(mode));
    if (batch) { assert.match(frame, /exit 127/); assert.match(frame, /exit 0/); assert.match(frame, /●/); }
  } finally {
    await act(async () => { card.renderer.destroy(); });
    await card.renderer.idle();
  }
}
services.dispose();
if (process.env.CLAI_CONFIRM_EVIDENCE) await writeFile(process.env.CLAI_CONFIRM_EVIDENCE, evidence.join("\n\n"));
console.log("Native confirmation layout passed: bounded previews, reasons, full review, controls, composer and tool status labels");
