import assert from "node:assert/strict";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { App } from "../../src/tui-v2/app/App.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { composerActionPort } from "../../src/ui-core/composer/composer-action-port.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";

let finish: (() => void) | undefined;
const services = createCompositionRoot({
  noHistory: true, mode: "agent", provider: "free", model: "fixture-model",
  agent: {
    async runTurn(_request, handlers) {
      handlers.onEvent?.({ type: "generation-completed", metrics: { outputTokens: 123, durationMs: 2_000 } });
      await new Promise<void>((resolve) => { finish = resolve; });
      return createTurnOutcome({ status: "succeeded", answer: "", steps: 1, remainingCriteria: [] });
    },
  },
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
  await settle(() => setup.mockInput.pressKey("\x1b[Z"));
  assert.equal(services.session.getState().mode, "plan");
  await settle(() => services.session.setMode("agent"));
  let pending: ReturnType<typeof services.session.submit> | undefined;
  await settle(() => { pending = services.session.submit("measure generation"); });
  assert.ok(finish);
  for (const busy of [true, false]) {
    if (!busy) await act(async () => { finish?.(); await pending; });
    for (const width of [24, 40, 80, 120]) {
      await settle(() => setup.resize(width, 30));
      const footer = setup.captureCharFrame().split("\n")[29]!;
      assert.match(footer, /61\.5 tok\/s/);
      assert.doesNotMatch(footer, /\bctx\b|⇧⇥|S-tab/);
      assert.equal(services.session.getState().running, busy);
    }
  }
  console.log("Native footer layout passed: resize, multiline drafts, exact busy/idle throughput, compact labels, and Shift+Tab keyboard behavior");
} finally {
  await act(async () => { services.dispose(); setup.renderer.destroy(); });
  await setup.renderer.idle();
}
