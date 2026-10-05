import assert from "node:assert/strict";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { registerModelCatalogFacts, clearModelCatalogFacts } from "../../src/llm/capabilities.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { App } from "../../src/tui-v2/app/App.js";

let submitted = 0;
const services = createCompositionRoot({
  noHistory: true,
  provider: "anthropic",
  model: "claude-sonnet-4",
  agent: {
    async runTurn() {
      submitted += 1;
      return createTurnOutcome({ status: "succeeded", answer: "", steps: 1, remainingCriteria: [] });
    },
  },
  persistence: {
    async saveSession() {},
    async loadPlan() { return undefined; },
    async savePlan() {},
    async deletePlan() {},
  },
  capabilities: detectCapabilities({
    env: { COLORTERM: "truecolor" },
    stdoutIsTTY: true,
    stdinIsTTY: true,
    columns: 120,
    rows: 30,
  }),
});
services.session.setContextLimitTokens(undefined);
registerModelCatalogFacts("anthropic", { id: "claude-sonnet-4", contextTokens: 200_000 });
const setup = await testRender(
  createElement(ServicesProvider, { services, children: createElement(App) }),
  { width: 120, height: 30, kittyKeyboard: true, useMouse: true, useThread: false },
);

async function settle(action: () => unknown = () => undefined): Promise<string> {
  await act(async () => { await action(); });
  await act(async () => { await setup.flush(); });
  return setup.captureCharFrame();
}

async function clickLabel(label: string): Promise<string> {
  const lines = setup.captureCharFrame().split("\n");
  const y = lines.findIndex((line) => line.includes(label));
  assert.ok(y >= 0, `missing ${label}\n${lines.join("\n")}`);
  await settle(() => setup.mockMouse.click(lines[y]!.indexOf(label) + 1, y));
  return settle(() => setup.mockMouse.moveTo(0, 0));
}

async function changeLimit(value: string): Promise<void> {
  const current = String(services.session.getState().contextUsage?.contextLimit ?? "");
  for (let i = 0; i < current.length; i += 1) {
    await settle(() => setup.mockInput.pressBackspace());
  }
  await settle(() => setup.mockInput.typeText(value));
}

try {
  await settle();
  await settle(() => setup.mockInput.typeText("keep this prompt"));
  assert.match(await clickLabel("ctx 0/200k"), /ctx limit/);
  await changeLimit("500k");
  const saved = await settle(() => setup.mockInput.pressEnter());
  assert.equal(services.session.getState().contextUsage?.contextLimit, 500_000);
  assert.match(saved, /ctx 0\/500k/);
  assert.match(saved, /keep this prompt/);

  await clickLabel("ctx 0/500k");
  await changeLimit("100k");
  await settle(() => setup.mockInput.pressEnter());
  assert.equal(services.session.getState().contextUsage?.contextLimit, 100_000);

  await clickLabel("ctx 0/100k");
  await changeLimit("1m");
  await settle(() => setup.mockInput.pressEscape());
  assert.equal(services.session.getState().contextUsage?.contextLimit, 100_000);

  await clickLabel("ctx 0/100k");
  await changeLimit("10k");
  assert.match(await settle(() => setup.mockInput.pressEnter()), /ctx limit/);
  assert.equal(services.session.getState().contextUsage?.contextLimit, 100_000);
  assert.match(await clickLabel("reset"), /ctx 0\/200k/);
  assert.equal(services.session.getState().contextUsage?.contextLimit, 200_000);

  clearModelCatalogFacts();
  await settle(() => services.session.setContextLimitTokens(undefined));
  assert.equal(services.session.getState().contextLimit?.source, "model-table");
  await clickLabel("ctx 0/200k");
  await changeLimit("1m");
  assert.match(await settle(() => setup.mockInput.pressEnter()), /ctx 0\/1M/);
  assert.equal(services.session.getState().contextUsage?.contextLimit, 1_000_000);
  await clickLabel("ctx 0/1M");
  await changeLimit("");
  assert.match(await settle(() => setup.mockInput.pressEnter()), /ctx 0\/200k/);
  assert.equal(services.session.getState().contextUsage?.contextLimit, 200_000);

  assert.match(await settle(() => setup.mockInput.typeText("!")), /keep this prompt!/);
  assert.equal(submitted, 0);
  console.log("Native context chip passed: provider/model overrides, save, cancel, reset, validation, and composer focus/draft preservation");
} finally {
  services.session.setContextLimitTokens(undefined);
  clearModelCatalogFacts();
  await act(async () => {
    services.dispose();
    setup.renderer.destroy();
  });
  await setup.renderer.idle();
}
