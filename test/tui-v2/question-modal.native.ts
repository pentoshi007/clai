import assert from "node:assert/strict";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { App } from "../../src/tui-v2/app/App.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import type { QuestionAnswer, QuestionRequest } from "../../src/app/ports/question-port.js";

const services = createCompositionRoot({
  noHistory: true, provider: "openai", model: "test-model",
  persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: 100, rows: 30 }),
});
const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), {
  width: 100, height: 30, kittyKeyboard: true, useThread: false,
});
const settle = async (action: () => unknown = () => undefined): Promise<string> => {
  await act(async () => { action(); await new Promise((resolve) => setTimeout(resolve, 40)); });
  await act(async () => { await setup.flush(); });
  return setup.captureCharFrame();
};

const request: QuestionRequest = {
  questions: [
    {
      question: "Which session store should the API use?",
      header: "Storage",
      options: [
        { label: "Postgres (Recommended)", description: "Already provisioned" },
        { label: "Redis", description: "New service to run" },
      ],
      multiSelect: false,
    },
    { question: "Anything to add?", options: [{ label: "No" }, { label: "Yes" }], multiSelect: false },
  ],
};

try {
  let answers!: Promise<readonly QuestionAnswer[] | undefined>;
  const frame = await settle(() => {
    answers = services.ports.askUser!(request);
  });
  assert.ok(setup.renderer.root.findDescendantById("question-modal"), frame);
  assert.match(frame, /STORAGE 1\/2/);
  assert.match(frame, /Which session store should the API use\?/);
  assert.match(frame, /1\. Postgres \(Recommended\)/);
  assert.match(frame, /3\. Type your own answer/);
  assert.match(frame, /esc skip/);

  const second = await settle(() => setup.mockInput.pressKey("2"));
  assert.match(second, /Anything to add\?/);
  await settle(() => setup.mockInput.pressKey("3"));
  for (const char of "cache") await settle(() => setup.mockInput.pressKey(char));
  const editing = await settle(() => setup.mockInput.pressEscape());
  assert.equal(services.overlay.getState().kind, "question", editing);
  await settle(() => setup.mockInput.pressKey("3"));
  for (const char of "ttl") await settle(() => setup.mockInput.pressKey(char));
  await settle(() => setup.mockInput.pressEnter());
  assert.deepEqual(await answers, [{ selected: ["Redis"] }, { selected: [], custom: "ttl" }]);
  assert.equal(services.overlay.getState().kind, "none");

  let skipped!: Promise<readonly QuestionAnswer[] | undefined>;
  await settle(() => {
    skipped = services.ports.askUser!(request);
  });
  await settle(() => setup.mockInput.pressEscape());
  assert.equal(await skipped, undefined);
  console.log("Native question modal passed");
} finally {
  setup.renderer.destroy();
  services.dispose?.();
}
