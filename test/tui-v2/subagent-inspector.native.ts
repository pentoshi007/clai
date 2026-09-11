import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { RGBA } from "@opentui/core";
import { SubagentManager } from "../../src/agent/subagents/manager.js";
import type { SubagentWorkerInput } from "../../src/agent/subagents/types.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { attachCommandHandlers } from "../../src/ui-core/commands/command-handlers.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { App } from "../../src/tui-v2/app/App.js";
import { themeFor, type Theme } from "../../src/ui-core/rendering/theme.js";

const workers = new Map<string, SubagentWorkerInput>();
const manager = new SubagentManager("native-parent", {
  worker: (input) => new Promise<string>((resolve) => {
    workers.set(input.run.id, input);
    input.signal.addEventListener("abort", () => resolve("stopped"), { once: true });
  }),
});
let finishMain!: () => void;
let mainAborted = false;
const services = createCompositionRoot({
  noHistory: true,
  provider: "openai",
  model: "test-model",
  agent: {
    async runTurn(_request, handlers) {
      handlers.signal?.addEventListener("abort", () => { mainAborted = true; });
      await new Promise<void>((resolve) => { finishMain = resolve; });
      return createTurnOutcome({ status: "succeeded", answer: "done", steps: 0, remainingCriteria: [] });
    },
  },
  persistence: {
    async saveSession() {},
    async loadPlan() { return undefined; },
    async savePlan() {},
    async deletePlan() {},
  },
  capabilities: detectCapabilities({
    env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: 120, rows: 40,
  }),
});
Object.defineProperty(services.session, "subagents", { get: () => manager });
attachCommandHandlers(services);
const node = createElement(ServicesProvider, { services, children: createElement(App) });
const setup = await testRender(node, { width: 120, height: 40, kittyKeyboard: true, useThread: false });
const settle = async (action: () => unknown = () => undefined): Promise<string> => {
  await act(async () => {
    await action();
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  await setup.flush();
  return setup.captureCharFrame();
};
const waitForFrame = async (pattern: RegExp, action: () => unknown): Promise<string> => {
  let frame = await settle(action);
  const deadline = Date.now() + 2000;
  while (!pattern.test(frame) && Date.now() < deadline) frame = await settle();
  assert.match(frame, pattern);
  return frame;
};
let main: Promise<unknown> | undefined;
const assertColor = (text: string, token: keyof Theme): void => {
  const expected = RGBA.fromHex(themeFor(services.capabilities.themeHint)[token]);
  const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
  assert.ok(spans.some((span) => span.text.includes(text) && span.fg.equals(expected)), `${text} should use ${token}`);
};
try {
  await setup.flush();
  await settle(() => services.commands.dispatch({ name: "orchestration", args: "on" }));
  const first = manager.start({ title: "First inspector", prompt: "inspect first", cwd: process.cwd(), provider: "openai", model: "test" });
  const second = manager.start({ title: "Second inspector", prompt: "inspect second", cwd: process.cwd(), provider: "openai", model: "test" });
  await settle(() => { main = services.session.submit("Keep the main turn running"); });
  assert.equal(services.session.getState().running, true);
  const pickerFrame = await settle(() => {
    services.toast.info("Orchestration on · independent research continues while inspecting agents", { sticky: true });
    services.commands.dispatch({ name: "agents" });
  });
  assert.match(pickerFrame, /First inspector/);
  assert.match(pickerFrame.split("\n")[0]!, /Orchestration on/);
  assert.match(pickerFrame, /Main agent/);
  assert.match(pickerFrame, /Second inspector/);
  await settle(() => setup.mockInput.pressArrow("down"));
  await settle(() => setup.mockInput.pressEnter());
  assert.equal(services.overlay.getState().kind, "pager");
  await waitForFrame(/FIRST LIVE FINDING/, () => workers.get(first.id)!.emit({ kind: "assistant", text: "FIRST LIVE FINDING" }));
  const activityFrame = await waitForFrame(/✓ fs\.read/, () => {
    const worker = workers.get(first.id)!;
    worker.emit({ kind: "tool", text: 'Calling fs.read: {"path":"src/agent/subagents/worker.ts","offset":81,"limit":80}' });
    worker.emit({ kind: "tool", text: "Success: PRIVATE_FILE_BODY_MUST_NOT_APPEAR" });
  });
  assert.match(activityFrame, /fs\.read src\/agent\/subagents\/worker\.ts/);
  assert.match(activityFrame, /offset=81, limit=80/);
  assert.doesNotMatch(activityFrame, /PRIVATE_FILE_BODY_MUST_NOT_APPEAR/);
  assertColor("fs.read", "cyan");
  assertColor("✓", "success");
  assertColor("Activity", "magenta");
  await settle(() => setup.mockInput.pressKey("r"));
  assertColor("fs.read", "cyan");
  assertColor("✓", "success");
  await settle(() => setup.mockInput.pressKey("f"));
  await waitForFrame(/Notice: Retrying request/, () => {
    const worker = workers.get(first.id)!;
    worker.emit({ kind: "tool", text: 'Calling web.fetch: {"url":"https://example.test"}' });
    worker.emit({ kind: "tool", text: "Error: Test failure" });
    worker.emit({ kind: "notice", text: "Retrying request" });
  });
  assertColor("web.fetch", "cyan");
  assertColor("✗", "diffDel");
  assertColor("Notice:", "activity");
  if (process.env.CLAI_SUBAGENT_CAPTURE_PATH) await writeFile(process.env.CLAI_SUBAGENT_CAPTURE_PATH, activityFrame);
  await settle(() => setup.mockInput.pressEscape());
  assert.equal(services.overlay.getState().kind, "picker");
  const frame = await waitForFrame(/SECOND LIVE FINDING/, () => {
    services.overlay.selectPicker(second.id);
    workers.get(second.id)!.emit({ kind: "assistant", text: "SECOND LIVE FINDING" });
  });
  assert.match(frame, /SECOND LIVE FINDING/);
  assert.doesNotMatch(frame, /FIRST LIVE FINDING/);
  await waitForFrame(/Stopped by parent/, () => manager.stop(second.id));
  assert.equal(manager.get(second.id)?.status, "stopped");
  await settle(() => setup.mockInput.pressEscape());
  await settle(() => services.overlay.selectPicker("main"));
  assert.equal(services.overlay.getState().kind, "none");
  assert.equal(services.session.getState().running, true);
  assert.equal(mainAborted, false);
  await settle(async () => { finishMain(); await main; });
  console.log("Native subagent inspector passed: live output, child switching, Escape, final status, and uninterrupted main turn");
} finally {
  await act(async () => {
    finishMain?.();
    await main;
    manager.dispose();
    services.dispose();
    setup.renderer.destroy();
  });
  await setup.renderer.idle();
}
