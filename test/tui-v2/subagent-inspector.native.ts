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

const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;

const workers = new Map<string, SubagentWorkerInput>();
const resolvers = new Map<string, (report: string) => void>();
const manager = new SubagentManager("native-parent", {
  worker: (input) => new Promise<string>((resolve) => {
    workers.set(input.run.id, input);
    resolvers.set(input.run.id, resolve);
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
Object.assign(services.session, {
  setOrchestrationEnabled: (enabled: boolean) => manager.setEnabled(enabled),
  restartSubagent: (id: string) => { manager.restart(id); },
} satisfies Pick<typeof services.session, "setOrchestrationEnabled" | "restartSubagent">);
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
  const collapsedFrame = await waitForFrame(/Subagents: 2 running · 0 done/, () => undefined);
  const headerRow = collapsedFrame.split("\n").findIndex((line) => line.includes("Subagents:"));
  const expandedFrame = await settle(() => setup.mockMouse.click(6, headerRow));
  assert.match(expandedFrame, /First inspector/);
  assert.match(expandedFrame, /running · elapsed/);
  clockOffset += 60_000;
  const livePanelFrame = await settle(() => new Promise((resolve) => setTimeout(resolve, 1100)));
  assert.match(livePanelFrame, /running · elapsed 1m/);
  await settle(() => { main = services.session.submit("Keep the main turn running"); });
  assert.equal(services.session.getState().running, true);
  const pickerFrame = await settle(() => {
    services.toast.info("Orchestration on · independent research continues while inspecting agents", { sticky: true });
    services.commands.dispatch({ name: "subagents" });
  });
  assert.match(pickerFrame, /First inspector/);
  assert.match(pickerFrame.split("\n")[0]!, /Orchestration on/);
  assert.match(pickerFrame, /Main agent/);
  assert.match(pickerFrame, /Second inspector/);
  assert.match(pickerFrame, /elapsed 1m/);
  clockOffset += 60_000;
  const livePickerFrame = await settle(() => new Promise((resolve) => setTimeout(resolve, 1100)));
  assert.match(livePickerFrame, /elapsed 2m/);
  const filteredFrame = await settle(() => setup.mockInput.typeText("inspector"));
  assert.match(filteredFrame, /filter: inspector/);
  const selectedPickerFrame = await settle(() => setup.mockInput.pressArrow("down"));
  assert.match(selectedPickerFrame, /[❯›>] .*First inspector/);
  clockOffset += 60_000;
  const filteredTickFrame = await settle(() => new Promise((resolve) => setTimeout(resolve, 1100)));
  assert.match(filteredTickFrame, /filter: inspector/);
  assert.match(filteredTickFrame, /[❯›>] .*First inspector/);
  await settle(() => setup.mockInput.pressEnter());
  const inspector = services.overlay.getState();
  assert.equal(inspector.kind, "pager");
  assert.equal(inspector.kind === "pager" && inspector.source?.path, `memory://subagent/${first.id}`);
  const elapsedFrame = await settle();
  assert.match(elapsedFrame, /Elapsed 3m/);
  clockOffset += 60_000;
  const livePagerFrame = await settle(() => new Promise((resolve) => setTimeout(resolve, 1100)));
  assert.match(livePagerFrame, /Elapsed 4m/);
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
  await waitForFrame(/--passWithNoTests/, () => {
    const worker = workers.get(first.id)!;
    worker.emit({ kind: "tool", text: 'Calling shell.exec: {"command":"npm run test --coverage --reporter=json --outputFile=/tmp/clai/coverage/coverage-final.json --watch=false --passWithNoTests"}' });
    worker.emit({ kind: "tool", text: "Success: exit 0" });
  });
  assertColor("shell.exec", "cyan");
  assertColor("--passWithNoTests", "muted");
  await settle(() => setup.mockInput.pressKey("r"));
  assertColor("fs.read", "cyan");
  assertColor("✓", "success");
  assertColor("--passWithNoTests", "muted");
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
  const stoppedFrame = await settle();
  const finalDuration = stoppedFrame.match(/Duration ([\w.]+)/)?.[0];
  assert.ok(finalDuration);
  clockOffset += 60_000;
  assert.ok((await settle()).includes(finalDuration));
  await settle(() => setup.mockInput.pressEscape());
  await settle(() => services.overlay.selectPicker("main"));
  assert.equal(services.overlay.getState().kind, "none");
  assert.equal(services.session.getState().running, true);
  assert.equal(mainAborted, false);
  const doneFrame = await waitForFrame(/Subagents: 0 running · 2 done/, () => resolvers.get(first.id)!("Status: complete\n## Findings\nThe inspector gathered all required evidence.\n## Evidence\nsrc/agent/subagents/worker.ts:81 contains the worker.\n## Next steps\nNo further work.\n## Coverage gaps\nNo live provider was contacted."));
  assert.match(doneFrame, /completed · duration/);
  assert.match(doneFrame, /stopped · duration/);
  clockOffset += 60_000;
  const frozenPanelFrame = await settle();
  assert.equal(frozenPanelFrame.match(/completed · duration [\w.]+/)?.[0], doneFrame.match(/completed · duration [\w.]+/)?.[0]);
  assert.equal(frozenPanelFrame.match(/stopped · duration [\w.]+/)?.[0], doneFrame.match(/stopped · duration [\w.]+/)?.[0]);
  await settle(() => {
    manager.acknowledgeResult(first.id, manager.get(first.id)!.attempt);
    manager.acknowledgeResult(second.id, manager.get(second.id)!.attempt);
  });
  const deliveredFrame = await settle();
  assert.doesNotMatch(deliveredFrame, /Subagents:/);
  await settle(async () => { finishMain(); await main; });
  console.log("Native subagent inspector passed: live output, wrapped tool colors, child switching, Escape, final status, delivered-results bar removal, and uninterrupted main turn");
} finally {
  await act(async () => {
    finishMain?.();
    await main;
    manager.dispose();
    services.dispose();
    setup.renderer.destroy();
  });
  await setup.renderer.idle();
  Date.now = realNow;
}
