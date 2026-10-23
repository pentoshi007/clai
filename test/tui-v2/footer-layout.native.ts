import assert from "node:assert/strict";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { App } from "../../src/tui-v2/app/App.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { composerActionPort } from "../../src/ui-core/composer/composer-action-port.js";

const services = createCompositionRoot({
  noHistory: true, mode: "agent",
  persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  capabilities: detectCapabilities({ env: {}, stdoutIsTTY: true, stdinIsTTY: true, columns: 120, rows: 40 }),
});
const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), {
  width: 120, height: 40, useThread: false,
});
async function settle(action: () => void): Promise<void> {
  await act(async () => { action(); await new Promise(resolve => setTimeout(resolve, 30)); });
  await act(async () => { await setup.flush(); });
}
try {
  for (const [width, height] of [[120, 40], [80, 24], [40, 12], [160, 50], [80, 16], [120, 40]] as const) {
    await settle(() => setup.resize(width, height));
    assert.match(setup.captureCharFrame().split("\n")[height - 1]!, /AGENT/);
    await settle(() => composerActionPort.insert("draft line\n".repeat(8)));
    assert.match(setup.captureCharFrame().split("\n")[height - 1]!, /AGENT/);
    await settle(() => composerActionPort.clear());
  }
  console.log("Native footer layout passed: final-row metadata across resize and multiline drafts");
} finally {
  await act(async () => { services.dispose(); setup.renderer.destroy(); });
  await setup.renderer.idle();
}
