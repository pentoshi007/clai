import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { render } from "ink-testing-library";

import type { AgentPort, RunTurnHandlers, RunTurnRequest } from "../../src/app/ports/agent-port.js";
import type { ChatMessage } from "../../src/types.js";
import type { PersistencePort } from "../../src/app/ports/persistence-port.js";
import { createTurnOutcome, type TurnOutcome } from "../../src/agent/turn-outcome.js";
import { createCompositionRoot, type AppServices } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { ClassicApp } from "../../src/classic/app/ClassicApp.js";

class StubAgent implements AgentPort {
  async runTurn(
    _req: RunTurnRequest,
    handlers: RunTurnHandlers,
  ): Promise<TurnOutcome> {
    const outcome = createTurnOutcome({
      status: "succeeded",
      answer: "hi",
      steps: 1,
      remainingCriteria: [],
    });
    handlers.onEvent({ type: "turn-start", prompt: "go" });
    handlers.onEvent({ type: "assistant-message", text: "hi" });
    handlers.onEvent({ type: "turn-end", outcome, finalAnswer: "hi", steps: 1 });
    return outcome;
  }
}

const caps = detectCapabilities({
  env: { COLORTERM: "truecolor" },
  stdoutIsTTY: true,
  stdinIsTTY: true,
  columns: 120,
  rows: 40,
});

export function makeServices(): AppServices {
  const persistence: PersistencePort = {
    async saveSession() {},
    async loadPlan() {
      return undefined;
    },
    async savePlan() {},
    async deletePlan() {},
  };
  return createCompositionRoot({
    agent: new StubAgent(),
    persistence,
    capabilities: caps,
  });
}

describe("ClassicApp shell", () => {
  it("renders mode, provider, and the exit hint", () => {
    const services = makeServices();
    const { lastFrame, unmount, cleanup } = render(
      createElement(ServicesProvider, {
        services,
        children: createElement(ClassicApp),
      }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("clai");
    expect(frame).toContain("classic");
    expect(frame).toContain("Ctrl+C twice to exit");
    expect(frame).toContain(services.session.getState().mode);
    unmount();
    cleanup();
    services.dispose();
  });

  it("updates the agent card mode when Shift+Tab cycles the mode", async () => {
    const services = makeServices();
    const { lastFrame, unmount, cleanup } = render(
      createElement(ServicesProvider, {
        services,
        children: createElement(ClassicApp),
      }),
    );
    const initial = lastFrame() ?? "";
    expect(initial).toContain("AGENT MODE");

    services.session.setMode("plan");
    await vi.waitFor(() => {
      const frame = lastFrame() ?? "";
      expect(frame).toContain("PLAN MODE");
      expect(frame).not.toContain("AGENT MODE");
    });

    services.session.setMode("ask");
    await vi.waitFor(() => {
      const frame = lastFrame() ?? "";
      expect(frame).toContain("ASK MODE");
      expect(frame).not.toContain("PLAN MODE");
    });

    unmount();
    cleanup();
    services.dispose();
  });
});
