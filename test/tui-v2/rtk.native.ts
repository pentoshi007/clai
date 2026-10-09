import assert from "node:assert/strict";
import { mock } from "bun:test";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { RtkGain } from "../../src/tools/rtk/binary.js";

const binary = await import("../../src/tools/rtk/binary.js");
let gain: RtkGain | undefined = { commands: 800, savedTokens: 1_486_906, savingsPct: 82.54 };
let response: Promise<RtkGain | undefined> | undefined;
let gainReads = 0;
let gainSession: string | undefined;
mock.module("../../src/tools/rtk/binary.js", () => ({
  ...binary,
  detectRtk: async () => ({ state: "ready", path: "/opt/bin/rtk", version: "0.51.0" }),
  readRtkGain: async (_path: string, sessionId?: string) => { gainReads += 1; gainSession = sessionId; return response ?? gain; },
}));

const { createCompositionRoot } = await import("../../src/ui-core/bootstrap/composition-root.js");
const { detectCapabilities } = await import("../../src/ui-core/bootstrap/capabilities.js");
const { attachCommandHandlers } = await import("../../src/ui-core/commands/command-handlers.js");
const { ServicesProvider } = await import("../../src/ui-core/react/providers.js");
const { App } = await import("../../src/tui-v2/app/App.js");
const { updateConfig } = await import("../../src/store/config.js");
const { createRtkExecutionRecorder } = await import("../../src/store/rtk-usage.js");

updateConfig({ rtk: true });
const services = createCompositionRoot({
  noHistory: true,
  persistence: {
    async saveSession() {},
    async loadPlan() { return undefined; },
    async savePlan() {},
    async deletePlan() {},
  },
  capabilities: detectCapabilities({
    env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: 120, rows: 35,
  }),
});
attachCommandHandlers(services);
createRtkExecutionRecorder(services.session.sessionId)();
const setup = await testRender(
  createElement(ServicesProvider, { services, children: createElement(App) }),
  { width: 120, height: 35, kittyKeyboard: true, useMouse: true, useThread: false },
);

async function settle(action: () => unknown = () => undefined): Promise<string> {
  await act(async () => { await action(); });
  await act(async () => { await setup.flush(); });
  return setup.captureCharFrame().replace(/\s+/g, " ");
}

async function waitFor(text: string): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const frame = await settle();
    if (frame.includes(text)) return frame;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Missing ${text}: ${setup.captureCharFrame()}`);
}

try {
  await settle();
  await settle(() => setup.mockInput.typeText("/rtk"));
  await settle(() => setup.mockInput.pressEnter());
  const opened = await waitFor("rtk 0.51.0");
  assert.match(opened, /1 automatic RTK run this session/);
  assert.match(opened, /1\.5M estimated tokens saved this session \(83%\)/);
  assert.equal(gainSession, services.session.sessionId);
  await settle(() => setup.mockInput.pressArrow("down"));
  await settle(() => setup.mockInput.pressArrow("down"));
  let resolve!: (gain: RtkGain | undefined) => void;
  response = new Promise((settle) => { resolve = settle; });
  assert.match(await settle(() => setup.mockInput.pressEnter()), /Detecting rtk…/);
  resolve(undefined);
  assert.match(await waitFor("RTK savings unavailable"), /select to refresh/);
  assert.equal(services.focus.activeContext(), "picker");
  assert.equal(gainReads, 2);
  response = undefined;
  gain = { commands: 0, savedTokens: 0, savingsPct: 0 };
  await settle(() => setup.mockInput.pressEnter());
  await waitFor("no RTK savings recorded for this session yet");
  await settle(() => setup.mockInput.pressEscape());
  assert.equal(services.overlay.getState().kind, "none");
  assert.equal(services.focus.activeContext(), "composer");
  assert.match(await settle(() => setup.mockInput.typeText("still usable")), /still usable/);
  console.log("Native RTK passed: slash entry, session statistics, keyboard refresh, unavailable/empty recovery, and composer focus");
} finally {
  await act(async () => {
    services.dispose();
    setup.renderer.destroy();
  });
  await setup.renderer.idle();
  mock.restore();
}
