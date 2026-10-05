import assert from "node:assert/strict";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { attachCommandHandlers } from "../../src/ui-core/commands/command-handlers.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { App } from "../../src/tui-v2/app/App.js";

for (const width of [120, 80]) {
  const services = createCompositionRoot({
    persistence: {
      async saveSession() {}, async loadPlan() { return undefined; },
      async savePlan() {}, async deletePlan() {},
    },
    capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: width, rows: 35 }),
  });
  attachCommandHandlers(services);
  const journal = services.session.promptHistory;
  await journal.append({ content: "First research request", timestamp: 1791110400000, provider: "codex", model: "model-a", effort: "xhigh" });
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
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Missing ${text}: ${setup.captureCharFrame()}`);
  }
  try {
    await settle();
    await settle(() => setup.mockInput.typeText("/prompts"));
    await settle(() => setup.mockInput.pressEnter());
    const opened = await waitFor("First research request");
    for (const detail of ["Session prompts", "Prompt 001", "2026", "codex", "model-a", "xhigh"]) assert.ok(opened.includes(detail), opened);
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
  } finally {
    await act(async () => { services.dispose(); setup.renderer.destroy(); });
    await setup.renderer.idle();
  }
}
console.log("Native prompts passed: sections, timestamps, submitted routes, disk paging/search, and composer focus at 120/80 columns");
