import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { TextareaRenderable, type Renderable } from "@opentui/core";
import { spyOn } from "bun:test";
import { getProvider } from "../../src/llm/router.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { attachCommandHandlers } from "../../src/ui-core/commands/command-handlers.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { App } from "../../src/tui-v2/app/App.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { SessionPromptStore } from "../../src/store/session-prompts.js";

for (const provider of ["free", "openai"] as const) {
  spyOn(getProvider(provider), "listModels").mockResolvedValue([]);
}
const requests = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Native prompt fixture must not access the network"));

const closed = new SessionPromptStore("closed-native-session");
await closed.append({ content: "Earlier request\n    Keep indentation" });
await closed.append({ content: "Newest saved request" });
await new SessionPromptStore("unrelated-native-session").append({ content: "Unrelated newer session prompt" });
for (const width of [120, 80]) {
  const services = createCompositionRoot({
    sessionId: closed.sessionId,
    provider: "free", model: "test-model",
    updates: { async check() { return { state: "current", currentVersion: "0.0.0", updateAvailable: false }; } },
    persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
    capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: width, rows: 35 }),
  });
  const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), { width, height: 35, kittyKeyboard: true, useThread: false });
  const descendants = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(descendants)];
  const editor = descendants(setup.renderer.root).find((node): node is TextareaRenderable => node instanceof TextareaRenderable);
  assert.ok(editor);
  const settle = async (action: () => unknown = () => undefined): Promise<void> => {
    await act(async () => { action(); await new Promise((resolve) => setTimeout(resolve, 110)); });
    await act(async () => { await setup.flush(); });
  };
  try {
    assert.equal(services.session.sessionId, closed.sessionId);
    await settle(() => setup.mockInput.typeText("Unsent draft"));
    await settle(() => setup.mockInput.pressArrow("up"));
    assert.equal(editor.plainText, "Newest saved request");
    await settle(() => setup.mockInput.pressArrow("up"));
    assert.equal(editor.plainText, "Earlier request\n    Keep indentation");
    await settle(() => setup.mockInput.pressArrow("up"));
    assert.equal(editor.plainText, "Earlier request\n    Keep indentation");
    await settle(() => setup.mockInput.pressArrow("down"));
    assert.equal(editor.plainText, "Newest saved request");
    await settle(() => setup.mockInput.pressArrow("down"));
    assert.equal(editor.plainText, "Unsent draft");
  } finally {
    await act(async () => { services.dispose(); setup.renderer.destroy(); });
    await setup.renderer.idle();
  }
}

for (const width of [120, 80]) {
  const services = createCompositionRoot({
    provider: "free", model: "test-model",
    updates: { async check() { return { state: "current", currentVersion: "0.0.0", updateAvailable: false }; } },
    agent: {
      async runTurn(request, handlers) {
        handlers.onMessages?.([
          { role: "user", content: request.prompt },
          { role: "assistant", content: "Assistant-only implementation details" },
        ]);
        return createTurnOutcome({ status: "succeeded", answer: "ok", steps: 1, remainingCriteria: [] });
      },
    },
    persistence: {
      async saveSession() {}, async loadPlan() { return undefined; },
      async savePlan() {}, async deletePlan() {},
    },
    capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: width, rows: 35 }),
  });
  attachCommandHandlers(services);
  const journal = services.session.promptHistory;
  const literalLines = ["clai set <provider> <key>, then clai use <provider>", "**literal** _text_ `command` [label](target)", "<p> <path> <br> <hr> a < b > c"];
  await journal.append({ content: ["First research request", ...literalLines].join("\n"), timestamp: 1791110400000, provider: "codex", model: "model-a", effort: "xhigh" });
  await journal.append({ content: `${"filler line\n".repeat(2200)}MIDDLE_NEEDLE\n${"more filler\n".repeat(2200)}` });
  await journal.append({ content: "Newest research request", timestamp: 1791110460000, provider: "openai", model: "model-b", effort: "low" });
  const setup = await testRender(
    createElement(ServicesProvider, { services, children: createElement(App) }),
    { width, height: 35, kittyKeyboard: true, useMouse: true, useThread: false },
  );
  async function settle(action: () => unknown = () => undefined): Promise<string> {
    await act(async () => { await action(); });
    await act(async () => { await setup.flush(); });
    return setup.captureCharFrame().replace(/\s+/g, " ");
  }
  async function waitFor(text: string): Promise<string> {
    for (let attempt = 0; attempt < 60; attempt++) {
      const frame = await settle();
      if (frame.includes(text)) return frame;
      await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 5)); });
    }
    throw new Error(`Missing ${text}: ${setup.captureCharFrame()}`);
  }
  try {
    await settle();
    await settle(() => setup.mockInput.typeText("/prompts"));
    await settle(() => setup.mockInput.pressEnter());
    const opened = await waitFor("First research request");
    const promptRow = setup.captureCharFrame().split("\n").find((line) => line.includes("First research request"))!;
    assert.equal((promptRow.match(/│/g) ?? []).length, 2, promptRow);
    for (const detail of ["Session prompts", "Prompt 001", "2026", "codex", "model-a", "xhigh"]) assert.ok(opened.includes(detail), opened);
    for (const line of literalLines) assert.ok(opened.includes(line), opened);
    assert.equal(services.focus.activeContext(), "pager");
    await settle(() => setup.mockInput.pressKey("\x1b[F"));
    const end = await waitFor("Newest research request");
    for (const detail of ["Prompt 003", "openai", "model-b", "low"]) assert.ok(end.includes(detail), end);
    await settle(() => setup.mockInput.pressKey("\x1b[H"));
    await waitFor("First research request");
    await settle(() => setup.mockInput.pressKey("r", { ctrl: true }));
    for (const char of "MIDDLE_NEEDLE") await settle(() => setup.mockInput.pressKey(char));
    await settle(() => setup.mockInput.pressEnter());
    await waitFor("MIDDLE_NEEDLE");
    await settle(() => setup.mockInput.pressEscape());
    await settle(() => setup.mockInput.typeText("q"));
    assert.equal(services.overlay.getState().kind, "none");
    assert.equal(services.focus.activeContext(), "composer");
    assert.match(await settle(() => setup.mockInput.typeText("still responsive")), /still responsive/);
    await settle(() => setup.mockInput.pressKey("q", { ctrl: true }));
    await settle(() => {
      services.session.reset({ mintNewId: true });
      services.session.setProvider("openai");
      services.session.setModel("test-model");
    });
    const recovered = services.session.promptHistory;
    await mkdir(recovered.path, { recursive: true });
    await settle(async () => {
      assert.equal((await services.session.submit("Recovered real submitted request")).status, "completed");
      await assert.rejects(recovered.flush(), { code: "EISDIR" });
      await services.session.persistNow("Native prompt recovery fixture");
    });
    assert.equal(services.session.getState().title, "Native prompt recovery fixture");
    await rm(recovered.path, { recursive: true });
    assert.equal(await recovered.count(), 0);
    await settle(() => setup.mockInput.typeText("/prompts"));
    await settle(() => setup.mockInput.pressEnter());
    const repaired = await waitFor("Recovered real submitted request");
    assert.doesNotMatch(repaired, /No user prompts have been sent|Assistant-only implementation details/);
    assert.equal(await recovered.count(), 1);
    await settle(() => setup.mockInput.typeText("q"));
    await settle(() => setup.mockInput.typeText("/prompts"));
    await settle(() => setup.mockInput.pressEnter());
    await waitFor("Recovered real submitted request");
    assert.equal(await recovered.count(), 1, "Repeated /prompts must not duplicate recovered prompts");
  } finally {
    await act(async () => { services.dispose(); setup.renderer.destroy(); });
    await setup.renderer.idle();
  }
}
assert.equal(requests.mock.calls.length, 0, "Native prompt browsing must be provider-independent");
console.log("Native prompts passed: sections, timestamps, submitted routes, disk paging/search, and composer focus at 120/80 columns");
