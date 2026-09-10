import assert from "node:assert/strict";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { SubagentManager } from "../../src/agent/subagents/manager.js";
import type { SubagentWorkerInput } from "../../src/agent/subagents/types.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { attachCommandHandlers } from "../../src/ui-core/commands/command-handlers.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { App } from "../../src/tui-v2/app/App.js";

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
let main: Promise<unknown> | undefined;
try {
  await setup.flush();
  await settle(() => services.commands.dispatch({ name: "orchestration", args: "on" }));
  const first = manager.start({ title: "First inspector", prompt: "inspect first", cwd: process.cwd(), provider: "openai", model: "test" });
  const second = manager.start({ title: "Second inspector", prompt: "inspect second", cwd: process.cwd(), provider: "openai", model: "test" });
  await settle(() => { main = services.session.submit("Keep the main turn running"); });
  assert.equal(services.session.getState().running, true);
  assert.match(await settle(() => services.commands.dispatch({ name: "agents" })), /First inspector/);
  await settle(() => setup.mockInput.pressArrow("down"));
  await settle(() => setup.mockInput.pressEnter());
  assert.equal(services.overlay.getState().kind, "pager");
  assert.match(await settle(() => workers.get(first.id)!.emit({ kind: "assistant", text: "FIRST LIVE FINDING" })), /FIRST LIVE FINDING/);
  await settle(() => setup.mockInput.pressEscape());
  assert.equal(services.overlay.getState().kind, "picker");
  const frame = await settle(() => {
    services.overlay.selectPicker(second.id);
    workers.get(second.id)!.emit({ kind: "assistant", text: "SECOND LIVE FINDING" });
  });
  assert.match(frame, /SECOND LIVE FINDING/);
  assert.doesNotMatch(frame, /FIRST LIVE FINDING/);
  assert.match(await settle(() => manager.stop(second.id)), /Stopped by parent/);
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
