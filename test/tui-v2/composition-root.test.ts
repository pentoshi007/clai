import { describe, expect, it } from "vitest";
import type {
  AgentPort,
  RunTurnHandlers,
  RunTurnRequest,
} from "../../src/app/ports/agent-port.js";
import type { ChatMessage } from "../../src/types.js";
import type { PersistencePort } from "../../src/app/ports/persistence-port.js";
import { createCompositionRoot } from "../../src/tui-v2/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/tui-v2/bootstrap/capabilities.js";

class StubAgent implements AgentPort {
  async runTurn(
    _req: RunTurnRequest,
    handlers: RunTurnHandlers,
  ): Promise<string> {
    handlers.onEvent({ type: "turn-start", prompt: "go" });
    handlers.onEvent({ type: "assistant-message", text: "hi" });
    handlers.onEvent({ type: "turn-end", finalAnswer: "hi", steps: 1 });
    handlers.onMessages?.([
      { role: "user", content: "go" },
      { role: "assistant", content: "hi" },
    ]);
    return "hi";
  }
}

function fakePersistence(): PersistencePort & { saved: ChatMessage[][] } {
  const saved: ChatMessage[][] = [];
  return {
    saved,
    async saveSession(messages) {
      saved.push([...messages]);
    },
    async loadPlan() {
      return undefined;
    },
    async savePlan() {},
    async deletePlan() {},
  };
}

const caps = detectCapabilities({
  env: { COLORTERM: "truecolor" },
  stdoutIsTTY: true,
  stdinIsTTY: true,
  columns: 120,
  rows: 40,
});

describe("createCompositionRoot", () => {
  it("assembles ports, controllers, registry, and capabilities from injected deps", () => {
    const services = createCompositionRoot({
      agent: new StubAgent(),
      persistence: fakePersistence(),
      capabilities: caps,
    });
    expect(services.ports.agent).toBeDefined();
    expect(services.commands.all().length).toBeGreaterThan(0);
    expect(services.router.resolve("enter", "composer")).toBe("editor.submit");
    expect(services.focus.activeContext()).toBe("composer");
    expect(services.capabilities.colorMode).toBe("truecolor");
    services.dispose();
  });

  it("records emitted app events when no external sink is provided", async () => {
    const services = createCompositionRoot({
      agent: new StubAgent(),
      persistence: fakePersistence(),
      capabilities: caps,
    });
    const result = await services.session.submit("go");
    expect(result.status).toBe("completed");
    expect(services.recordedEvents.length).toBeGreaterThan(0);
    // sequence is monotonic per session
    const seqs = services.recordedEvents.map((e) => e.sequence);
    expect([...seqs]).toEqual([...seqs].sort((a, b) => a - b));
    services.dispose();
  });

  it("forwards a supplied emit sink instead of recording", async () => {
    const seen: number[] = [];
    const services = createCompositionRoot({
      agent: new StubAgent(),
      persistence: fakePersistence(),
      capabilities: caps,
      emit: (e) => seen.push(e.sequence),
    });
    await services.session.submit("go");
    expect(seen.length).toBeGreaterThan(0);
    expect(services.recordedEvents).toHaveLength(0);
    services.dispose();
  });

  it("persists the session on turn completion", async () => {
    const persistence = fakePersistence();
    const services = createCompositionRoot({
      agent: new StubAgent(),
      persistence,
      capabilities: caps,
    });
    await services.session.submit("go");
    expect(persistence.saved.length).toBe(1);
    services.dispose();
  });

  it("dispose is idempotent", () => {
    const services = createCompositionRoot({
      agent: new StubAgent(),
      persistence: fakePersistence(),
      capabilities: caps,
    });
    services.dispose();
    expect(() => services.dispose()).not.toThrow();
  });
});
