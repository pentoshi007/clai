import assert from "node:assert/strict";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { attachCommandHandlers } from "../../src/ui-core/commands/command-handlers.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { App } from "../../src/tui-v2/app/App.js";
import { installQoderRuntimeFetch } from "../fixtures/qoder-runtime-fetch.js";
import { exerciseQoderUi, type QoderUiKey } from "../fixtures/qoder-ui-scenario.js";

const width = Number(process.argv[2]);
assert.ok([80, 120].includes(width));
const fixture = installQoderRuntimeFetch();
const services = createCompositionRoot({
  provider: "free", noHistory: true,
  persistence: {
    async saveSession() {}, async loadPlan() { return undefined; },
    async savePlan() {}, async deletePlan() {},
  },
  capabilities: detectCapabilities({ env: {}, stdoutIsTTY: true, stdinIsTTY: true, columns: width, rows: 35 }),
});
attachCommandHandlers(services);
const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), {
  width, height: 35, kittyKeyboard: true, useMouse: true, useThread: false,
});
async function frame(): Promise<string> {
  await act(async () => { await setup.flush(); });
  return setup.captureCharFrame().replace(/\s+/g, " ");
}
async function key(value: QoderUiKey): Promise<void> {
  await act(async () => {
    if (value === "escape") setup.mockInput.pressEscape();
    else if (value === "up" || value === "down") setup.mockInput.pressArrow(value);
    else if (value === "enter") setup.mockInput.pressEnter();
    else if (value === "save") setup.mockInput.pressEnter({ ctrl: true });
    else if (value === "activate") setup.mockInput.pressKey(" ");
    else if (value === "disable") setup.mockInput.pressKey("d");
    else if (value === "refresh") setup.mockInput.pressKey("r");
    else if (value === "remove") setup.mockInput.pressKey("x", { ctrl: true });
    else if (value === "reset") setup.mockInput.pressKey("r", { ctrl: true });
    else setup.mockInput.pressKey("a", { ctrl: true });
  });
  await frame();
}
try {
  await exerciseQoderUi({
    services, frame, key,
    async paste(text) {
      if (services.overlay.getState().kind === "picker") {
        for (const char of text) { await act(async () => { setup.mockInput.pressKey(char); }); await frame(); }
        return;
      }
      await act(async () => { await setup.mockInput.pasteBracketedText(text); }); await frame();
    },
  }, fixture);
} finally {
  await act(async () => { services.dispose(); setup.renderer.destroy(); });
  await setup.renderer.idle(); fixture.restore();
}
console.log(`OpenTUI Qoder auth passed at ${width} columns`);
