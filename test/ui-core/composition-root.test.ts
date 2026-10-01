import { describe, expect, it, vi } from "vitest";
import type {
  AgentPort,
  RunTurnHandlers,
  RunTurnRequest,
} from "../../src/app/ports/agent-port.js";
import type { ChatMessage } from "../../src/types.js";
import type { PersistencePort } from "../../src/app/ports/persistence-port.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { handleContext } from "../../src/ui-core/commands/session-commands.js";
import {
  clearModelCatalogFacts,
  registerModelCatalogFacts,
} from "../../src/llm/capabilities.js";
import { createTurnOutcome, type TurnOutcome } from "../../src/agent/turn-outcome.js";
import { RESPONDER_RESULT_LEDGER_PREFIX } from "../../src/agent/responder-context.js";

class StubAgent implements AgentPort {
  async runTurn(
    _req: RunTurnRequest,
    handlers: RunTurnHandlers,
  ): Promise<TurnOutcome> {
    const outcome = createTurnOutcome({ status: "succeeded", answer: "hi", steps: 1, remainingCriteria: [] });
    handlers.onEvent({ type: "turn-start", prompt: "go" });
    handlers.onEvent({ type: "assistant-message", text: "hi" });
    handlers.onEvent({ type: "turn-end", outcome, finalAnswer: "hi", steps: 1 });
    handlers.onMessages?.([
      { role: "user", content: "go" },
      { role: "assistant", content: "hi" },
    ]);
    return outcome;
  }
}

class UsageAgent implements AgentPort {
  async runTurn(
    _req: RunTurnRequest,
    handlers: RunTurnHandlers,
  ): Promise<TurnOutcome> {
    const outcome = createTurnOutcome({ status: "succeeded", answer: "usage", steps: 1, remainingCriteria: [] });
    handlers.onEvent({ type: "turn-start", prompt: "usage" });
    handlers.onEvent({
      type: "token-usage",
      provider: "openai",
      model: "gpt-test",
      usage: {
        promptTokens: 120,
        completionTokens: 20,
        totalTokens: 140,
        exact: true,
        cachedPromptTokens: 96,
        cacheCreationTokens: 4,
        uncachedPromptTokens: 20,
        reasoningTokens: 12,
      },
    });
    handlers.onEvent({ type: "assistant-message", text: "usage" });
    handlers.onEvent({ type: "turn-end", outcome, finalAnswer: "usage", steps: 1 });
    handlers.onMessages?.([
      { role: "user", content: "usage" },
      { role: "assistant", content: "usage" },
    ]);
    return outcome;
  }
}

class CarriedWorkAgent implements AgentPort {
  async runTurn(
    _req: RunTurnRequest,
    handlers: RunTurnHandlers,
  ): Promise<TurnOutcome> {
    const outcome = createTurnOutcome({ status: "succeeded", answer: "ok", steps: 1, remainingCriteria: [] });
    handlers.onEvent({ type: "turn-start", prompt: "go" });
    handlers.onEvent({ type: "assistant-message", text: "ok" });
    handlers.onEvent({ type: "turn-end", outcome, finalAnswer: "ok", steps: 1 });
    handlers.onMessages?.([
      { role: "user", content: ["staging API_TOKEN=", "tok_", "000000000001"].join("") },
      {
        role: "system",
        content: `${RESPONDER_RESULT_LEDGER_PREFIX}\n- notification=completion:job-1 job=job-1 status=exited consumed=true artifact=/a/job-1.log summary="14 routes, 3 open"`,
      },
      { role: "assistant", content: "ok" },
    ]);
    return outcome;
  }
}

class RatioUsageAgent implements AgentPort {
  async runTurn(
    _req: RunTurnRequest,
    handlers: RunTurnHandlers,
  ): Promise<TurnOutcome> {
    const outcome = createTurnOutcome({
      status: "succeeded",
      answer: "usage",
      steps: 1,
      remainingCriteria: [],
    });
    handlers.onEvent({ type: "turn-start", prompt: "usage" });
    handlers.onEvent({
      type: "token-usage",
      provider: "kiro",
      model: "provider-ratio-ui-model",
      usage: {
        promptTokens: 125_000,
        completionTokens: 0,
        totalTokens: 125_000,
        exact: false,
        promptTokensSource: "provider-ratio",
        contextWindowTokens: 1_000_000,
      },
    });
    handlers.onEvent({ type: "assistant-message", text: "usage" });
    handlers.onEvent({ type: "turn-end", outcome, finalAnswer: "usage", steps: 1 });
    handlers.onMessages?.([{ role: "assistant", content: "usage" }]);
    return outcome;
  }
}

class CompactionCountAgent implements AgentPort {
  async runTurn(
    _req: RunTurnRequest,
    handlers: RunTurnHandlers,
  ): Promise<TurnOutcome> {
    const outcome = createTurnOutcome({
      status: "succeeded",
      answer: "compacted",
      steps: 1,
      remainingCriteria: [],
    });
    handlers.onEvent({ type: "turn-start", prompt: "compact" });
    handlers.onEvent({
      type: "token-usage",
      provider: "openrouter",
      model: "stealth/ox-alpha",
      usage: {
        promptTokens: 78_200,
        completionTokens: 100,
        totalTokens: 78_300,
        exact: true,
      },
    });
    handlers.onEvent({
      type: "compaction-start",
      id: "compact-count",
      beforeTokens: 229_182,
    });
    handlers.onEvent({
      type: "compaction-completed",
      id: "compact-count",
      summary: "condensed",
      beforeTokens: 229_182,
      afterTokens: 4_922,
      contextScope: "assembled-request",
    });
    handlers.onEvent({
      type: "token-usage",
      provider: "openrouter",
      model: "stealth/ox-alpha",
      usage: {
        promptTokens: 94_000,
        completionTokens: 900,
        totalTokens: 94_900,
        exact: true,
      },
      auxiliary: true,
    });
    handlers.onEvent({
      type: "token-usage",
      provider: "openrouter",
      model: "stealth/ox-alpha",
      usage: {
        promptTokens: 4_800,
        completionTokens: 50,
        totalTokens: 4_850,
        exact: true,
      },
    });
    handlers.onEvent({
      type: "turn-end",
      outcome,
      finalAnswer: "compacted",
      steps: 1,
    });
    handlers.onMessages?.([
      { role: "user", content: "compact" },
      { role: "assistant", content: "compacted" },
    ]);
    return outcome;
  }
}

class FailedCompactionCountAgent implements AgentPort {
  async runTurn(
    _req: RunTurnRequest,
    handlers: RunTurnHandlers,
  ): Promise<TurnOutcome> {
    const outcome = createTurnOutcome({
      status: "succeeded",
      answer: "retained",
      steps: 1,
      remainingCriteria: [],
    });
    handlers.onEvent({ type: "turn-start", prompt: "compact" });
    handlers.onEvent({
      type: "token-usage",
      provider: "bynara",
      model: "qwen-3.8-max-free",
      usage: {
        promptTokens: 79_927,
        completionTokens: 100,
        totalTokens: 80_027,
        exact: true,
      },
    });
    handlers.onEvent({
      type: "compaction-start",
      id: "compact-first",
      beforeTokens: 137_391,
    });
    handlers.onEvent({
      type: "compaction-failed",
      id: "compact-first",
      message: "Compaction was cancelled.",
      retainedTokens: 137_391,
    });
    handlers.onEvent({
      type: "compaction-start",
      id: "compact-second",
      beforeTokens: 163_345,
    });
    handlers.onEvent({
      type: "compaction-failed",
      id: "compact-second",
      message: "Compaction was cancelled.",
      retainedTokens: 163_345,
    });
    handlers.onEvent({
      type: "turn-end",
      outcome,
      finalAnswer: "retained",
      steps: 1,
    });
    handlers.onMessages?.([
      { role: "user", content: "compact" },
      { role: "assistant", content: "retained" },
    ]);
    return outcome;
  }
}

class BurstAgent implements AgentPort {
  async runTurn(
    _req: RunTurnRequest,
    handlers: RunTurnHandlers,
  ): Promise<TurnOutcome> {
    const outcome = createTurnOutcome({
      status: "succeeded",
      answer: "done",
      steps: 1,
      remainingCriteria: [],
    });
    handlers.onEvent({ type: "turn-start", prompt: "burst" });
    for (let index = 0; index < 2_100; index += 1) {
      handlers.onEvent({ type: "assistant-delta", text: String(index % 10) });
    }
    handlers.onEvent({ type: "assistant-message", text: "done" });
    handlers.onEvent({
      type: "turn-end",
      outcome,
      finalAnswer: "done",
      steps: 1,
    });
    handlers.onMessages?.([
      { role: "user", content: "burst" },
      { role: "assistant", content: "done" },
    ]);
    return outcome;
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
    expect(services.recordedEvents).toHaveLength(0);
    services.dispose();
  });

  it("records emitted app events only when capture is enabled", async () => {
    const services = createCompositionRoot({
      agent: new StubAgent(),
      persistence: fakePersistence(),
      capabilities: caps,
      captureEvents: true,
    });
    const result = await services.session.submit("go");
    if (result.status === "error") throw result.error;
    expect(result.status).toBe("completed");
    expect(services.recordedEvents.length).toBeGreaterThan(0);
    // sequence is monotonic per session
    const seqs = services.recordedEvents.map((e) => e.sequence);
    expect([...seqs]).toEqual([...seqs].sort((a, b) => a - b));
    services.dispose();
  });

  it("propagates cache and reasoning telemetry into the shared context inspection command", async () => {
    const services = createCompositionRoot({
      agent: new UsageAgent(),
      persistence: fakePersistence(),
      capabilities: caps,
      captureEvents: true,
    });

    await services.session.submit("usage");

    expect(services.session.getState().contextSnapshot).toMatchObject({
      cache: {
        kind: "reported",
        readTokens: 96,
        creationTokens: 4,
        uncachedTokens: 20,
      },
      reasoning: { kind: "reported", outputTokens: 12 },
    });

    handleContext(services);
    const notice = services.recordedEvents.at(-1);
    expect(notice).toMatchObject({
      type: "notice",
      payload: {
        text: expect.stringContaining("cache read 96 / write 4 / uncached 20"),
      },
    });
    expect(
      notice?.type === "notice" ? notice.payload.text : "",
    ).toContain("reasoning output 12");
    services.dispose();
  });

  it("shows what survives compaction right after the context line, without leaking values", async () => {
    const services = createCompositionRoot({
      agent: new CarriedWorkAgent(),
      persistence: fakePersistence(),
      capabilities: caps,
      captureEvents: true,
    });
    try {
      await services.session.submit("go");
      await handleContext(services);
      const texts = services.recordedEvents.flatMap((event) =>
        event.type === "notice" ? [event.payload.text] : [],
      );
      const contextIndex = texts.findIndex((text) => text.startsWith("context: "));
      expect(contextIndex).toBeGreaterThanOrEqual(0);
      expect(texts[contextIndex + 1]).toBe(
        "carried across compaction: 1 responder result read (1 with a conclusion) · 1 credential",
      );
      expect(texts.join("\n")).not.toContain("000000000001");
    } finally {
      services.dispose();
    }
  });

  it("prints no carried-work line when nothing is carried, and survives a failing projection", async () => {
    const services = createCompositionRoot({
      agent: new StubAgent(),
      persistence: fakePersistence(),
      capabilities: caps,
      captureEvents: true,
    });
    try {
      await services.session.submit("go");
      await handleContext(services);
      const noticeTexts = (): string[] =>
        services.recordedEvents.flatMap((event) =>
          event.type === "notice" ? [event.payload.text] : [],
        );
      expect(noticeTexts().some((text) => text.startsWith("carried across compaction"))).toBe(false);

      const failing = vi
        .spyOn(services.session, "carriedWork")
        .mockRejectedValue(new Error("plan store unavailable"));
      await expect(handleContext(services)).resolves.toBeUndefined();
      expect(noticeTexts().some((text) => text.startsWith("carried across compaction"))).toBe(false);
      failing.mockRestore();
    } finally {
      services.dispose();
    }
  });

  it("reports provider-ratio usage against the advertised window", async () => {
    registerModelCatalogFacts("kiro", {
      id: "provider-ratio-ui-model",
      contextTokens: 1_000_000,
    });
    const services = createCompositionRoot({
      agent: new RatioUsageAgent(),
      persistence: fakePersistence(),
      capabilities: caps,
      captureEvents: true,
    });
    try {
      await services.session.submit("usage");
      expect(services.session.getState()).toMatchObject({
        contextChip: "ctx ~125,000/1M 13%",
        contextSnapshot: {
          precision: "provider-ratio",
          limit: {
            source: "model-catalog",
            tokens: 1_000_000,
            compactTriggerTokens: 700_000,
          },
        },
      });

      handleContext(services);
      const notice = services.recordedEvents.at(-1);
      const text = notice?.type === "notice" ? notice.payload.text : "";
      expect(text).toContain("provider-reported ~125,000 tokens");
      expect(text).toContain("limit 1,000,000 (provider)");
      expect(text).toContain("auto-compact at 700,000 (70%)");
    } finally {
      services.dispose();
      clearModelCatalogFacts();
    }
  });

  it("shows the compacted estimate until exact provider usage arrives", async () => {
    const observed: Array<[string, number | undefined]> = [];
    const afterAuxiliaryUsage: number[] = [];
    let services: ReturnType<typeof createCompositionRoot>;
    services = createCompositionRoot({
      agent: new CompactionCountAgent(),
      persistence: fakePersistence(),
      capabilities: caps,
      emit: (event) => {
        if (event.type === "token-usage" && event.payload.auxiliary) {
          afterAuxiliaryUsage.push(
            services.session.getState().contextSnapshot?.contextTokens ?? 0,
          );
        }
        if (
          event.type === "compaction-started" ||
          event.type === "compaction-completed"
        ) {
          observed.push([
            event.type,
            services.session.getState().contextSnapshot?.contextTokens,
          ]);
        }
      },
    });

    await services.session.submit("compact");

    expect(observed).toEqual([
      ["compaction-started", 78_200],
      ["compaction-completed", 4_922],
    ]);
    expect(afterAuxiliaryUsage).toEqual([4_922]);
    expect(services.session.getState().contextSnapshot).toMatchObject({
      contextTokens: 4_800,
      scope: "provider-request",
      precision: "provider-exact",
    });
    services.dispose();
  });

  it("shows the resolved window before any provider usage arrives", () => {
    const services = createCompositionRoot({
      agent: new StubAgent(),
      persistence: fakePersistence(),
      capabilities: caps,
    });

    const state = services.session.getState();
    expect(state.contextSnapshot).toBeUndefined();
    expect(state.contextUsage).toMatchObject({ contextTokens: 0, exact: false });
    expect(state.contextUsage?.contextLimit).toBeGreaterThan(0);
    expect(state.contextLimit?.tokens).toBe(state.contextUsage?.contextLimit);
    services.dispose();
  });

  it("keeps provider context unchanged across cancelled compactions", async () => {
    const observed: Array<[string, number | undefined]> = [];
    let services: ReturnType<typeof createCompositionRoot>;
    services = createCompositionRoot({
      agent: new FailedCompactionCountAgent(),
      persistence: fakePersistence(),
      capabilities: caps,
      emit: (event) => {
        if (
          event.type === "compaction-started" ||
          event.type === "compaction-failed"
        ) {
          observed.push([
            event.type,
            services.session.getState().contextSnapshot?.contextTokens,
          ]);
        }
      },
    });

    await services.session.submit("compact");

    expect(observed).toEqual([
      ["compaction-started", 79_927],
      ["compaction-failed", 79_927],
      ["compaction-started", 79_927],
      ["compaction-failed", 79_927],
    ]);
    expect(services.session.getState().contextSnapshot).toMatchObject({
      contextTokens: 79_927,
      scope: "provider-request",
      precision: "provider-exact",
    });
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

  it("bounds explicit event capture during long streaming turns", async () => {
    const services = createCompositionRoot({
      agent: new BurstAgent(),
      persistence: fakePersistence(),
      capabilities: caps,
      captureEvents: true,
    });

    await services.session.submit("burst");

    expect(services.recordedEvents).toHaveLength(2_000);
    expect(services.recordedEvents[0]?.sequence).toBeGreaterThan(1);
    expect(services.recordedEvents.at(-1)?.type).toBe("turn-ended");
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
    // Mid-turn autosave + end-of-turn persist may both write.
    expect(persistence.saved.length).toBeGreaterThanOrEqual(1);
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
