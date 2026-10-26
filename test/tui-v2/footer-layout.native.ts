import assert from "node:assert/strict";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { App } from "../../src/tui-v2/app/App.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { composerActionPort } from "../../src/ui-core/composer/composer-action-port.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import type { RunTurnHandlers } from "../../src/app/ports/agent-port.js";

let finish: (() => void) | undefined;
let activeHandlers: RunTurnHandlers | undefined;
const services = createCompositionRoot({
  noHistory: true, mode: "agent", provider: "free", model: "fixture-model",
  agent: {
    async runTurn(_request, handlers) {
      activeHandlers = handlers;
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
  await settle(() => activeHandlers?.onEvent?.({ type: "generation-progress", metrics: { outputTokens: 123, durationMs: 2_000, estimated: true } }));
  for (const busy of [true, false]) {
    if (!busy) await act(async () => {
      activeHandlers?.onEvent?.({ type: "generation-completed", metrics: { outputTokens: 123, durationMs: 2_000 } });
      finish?.();
      await pending;
    });
    for (const width of [24, 40, 80, 120]) {
      await settle(() => setup.resize(width, 30));
      const footer = setup.captureCharFrame().split("\n")[29]!;
      assert.match(footer, busy ? /~61\.5 tps/ : /61\.5 tps/);
      assert.doesNotMatch(footer, /\bctx\b|⇧⇥|S-tab|tok\/s/);
      assert.equal(services.session.getState().running, busy);
    }
  }
  await settle(() => { pending = services.session.submit("next generation"); });
  assert.match(setup.captureCharFrame().split("\n")[29]!, /61\.5 tps/);
  await settle(() => activeHandlers?.onEvent?.({ type: "generation-progress", metrics: { outputTokens: 100, durationMs: 2_000, estimated: true } }));
  assert.match(setup.captureCharFrame().split("\n")[29]!, /~50\.0 tps/);
  await act(async () => { finish?.(); await pending; });
  assert.match(setup.captureCharFrame().split("\n")[29]!, /~50\.0 tps/);
  for (const status of ["completed", "aborted", "error"] as const) {
    await settle(() => { pending = services.session.submit("hi"); });
    await settle(() => {
      activeHandlers?.onEvent({ type: "turn-start", prompt: "hi" });
      activeHandlers?.onEvent({ type: "generation-completed", metrics: { outputTokens: 66, durationMs: 3_000 } });
      activeHandlers?.onEvent({ type: "generation-completed", metrics: { outputTokens: 500, durationMs: 7_000 } });
    });
    assert.match(setup.captureCharFrame().split("\n")[29]!, /71\.4 tps/);
    await act(async () => {
      const outcome = createTurnOutcome({ status: "succeeded", answer: "hi", steps: 2, remainingCriteria: [] });
      if (status === "completed") activeHandlers?.onEvent({ type: "turn-end", finalAnswer: "hi", steps: 2, outcome });
      if (status === "aborted") activeHandlers?.onEvent({ type: "turn-aborted" });
      if (status === "error") activeHandlers?.onEvent({ type: "turn-error", message: "fixture error" });
      finish?.();
      await pending;
    });
    for (const width of [40, 80, 120]) {
      await settle(() => setup.resize(width, 30));
      const frame = setup.captureCharFrame();
      assert.match(frame, /Worked for/);
      if (status !== "completed") assert.ok(frame.includes(status), frame);
      assert.doesNotMatch(frame, /tok\/s/);
      assert.match(frame.split("\n")[29]!, /56\.6 tps/);
      assert.doesNotMatch(frame.split("\n").slice(0, 29).join("\n"), /\btps\b/);
      assert.doesNotMatch(frame, /71\.4 tps/);
    }
  }
  console.log("Native footer layout passed: resize, multiline drafts, live/exact/idle/new-turn throughput, aggregate TPS below composer only, compact labels, and Shift+Tab keyboard behavior");
} finally {
  await act(async () => { services.dispose(); setup.renderer.destroy(); });
  await setup.renderer.idle();
}
