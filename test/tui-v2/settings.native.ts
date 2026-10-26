import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { KeyEvent } from "@opentui/core";
import { installPasteBurstGuard } from "../../src/tui-v2/input/paste-burst-guard.js";
import { App } from "../../src/tui-v2/app/App.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { attachCommandHandlers } from "../../src/ui-core/commands/command-handlers.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { getConfig, getConfigPath, updateConfig } from "../../src/store/config.js";

for (const width of [100, 60, 30]) {
  updateConfig({ saveToolOutputs: false, privateMode: false });
  const services = createCompositionRoot({
    noHistory: true,
    persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
    capabilities: detectCapabilities({ env: {}, stdoutIsTTY: true, stdinIsTTY: true, columns: width, rows: 24 }),
  });
  attachCommandHandlers(services);
  const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), {
    width, height: 24, useThread: false,
  });
  const disposeGuard = installPasteBurstGuard<KeyEvent>(setup.renderer.keyInput, {
    enabled: () => services.focus.activeContext() !== "picker",
  });
  const settle = async (action: () => unknown = () => undefined): Promise<void> => {
    await act(async () => { await action(); });
    await act(async () => { await setup.flush(); });
  };
  const deliver = (text: string): Promise<void> => settle(() => setup.renderer.stdin.emit("data", Buffer.from(text)));
  const label = (): string | undefined => {
    const overlay = services.overlay.getState();
    assert.equal(overlay.kind, "picker");
    return overlay.kind === "picker" ? overlay.request.options[0]?.label : undefined;
  };
  try {
    await settle();
    await deliver("\x1b[200~/settings\x1b[201~");
    await settle(() => setup.mockInput.pressEnter());
    assert.equal(label(), "Save command outputs · Off");
    assert.match(setup.captureCharFrame(), /Save command outputs/);
    for (const key of ["\x1b[A", "\x1b[B", "\t", "\x1b[Z"]) {
      await deliver(key);
      assert.equal(label(), "Save command outputs · Off");
    }
    await deliver("\x1b[C");
    assert.equal(getConfig().saveToolOutputs, true);
    assert.equal(label(), "Save command outputs · On");
    assert.equal(JSON.parse(readFileSync(getConfigPath(), "utf8")).saveToolOutputs, true);
    await deliver("\x1b[D");
    assert.equal(getConfig().saveToolOutputs, false);
    await deliver(" ");
    assert.equal(getConfig().saveToolOutputs, true);
    await settle(() => setup.mockInput.pressEnter());
    assert.equal(getConfig().saveToolOutputs, false);
    await deliver("save");
    await deliver("\x1b[C");
    assert.equal(getConfig().saveToolOutputs, true);
    assert.match(setup.captureCharFrame(), /filter: save/);
    await deliver("zzzz");
    await deliver("\x1b[D");
    await settle(() => setup.mockInput.pressEnter());
    assert.equal(getConfig().saveToolOutputs, true);
    assert.match(setup.captureCharFrame(), /no matches/);
    await settle(() => setup.mockInput.pressEscape());
    await settle(() => new Promise((resolve) => setTimeout(resolve, 100)));
    assert.equal(services.overlay.isOpen(), false);
  } finally {
    disposeGuard();
    await act(async () => { services.dispose(); setup.renderer.destroy(); });
    await setup.renderer.idle();
  }
}
console.log("Native settings passed: slash dispatch, arrows, tab, space, enter, filtering and persistence at 100/60/30 columns");
