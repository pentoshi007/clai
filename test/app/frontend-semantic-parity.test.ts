import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/agent/events.js";
import {
  createTurnOutcome,
  type TurnOutcome,
} from "../../src/agent/turn-outcome.js";
import type {
  AgentPort,
  RunTurnHandlers,
  RunTurnRequest,
} from "../../src/app/ports/agent-port.js";
import type { PersistencePort } from "../../src/app/ports/persistence-port.js";
import type { AnyAppEvent } from "../../src/app/events/app-event.js";
import { createCompositionRoot, type AppServices } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { createClassicAppWiring } from "../../src/classic/app/app-wiring.js";
import { transcriptItems } from "../../src/ui-core/state/transcript-types.js";
import { StreamRenderer } from "../../src/noninteractive/stream-renderer.js";
import { fakeClock, fakeStream } from "../noninteractive/fixture.js";

const OUTCOME: TurnOutcome = createTurnOutcome({
  status: "succeeded",
  answer: "The cache holds 3 entries.",
  steps: 1,
  remainingCriteria: [],
});

const TRACE: readonly AgentEvent[] = [
  { type: "turn-start", prompt: "audit the cache" },
  { type: "thinking-block", content: "I should inspect the cache first." },
  { type: "assistant-message", text: "Checking the cache now." },
  { type: "tool-call", id: "c1", name: "fs.read", argsDisplay: "cache.json" },
  { type: "tool-start", id: "c1" },
  { type: "tool-output", id: "c1", chunk: "entries: 3" },
  {
    type: "tool-result",
    id: "c1",
    ok: true,
    exitCode: 0,
    summary: "read cache.json",
  },
  { type: "compaction-start", id: "k1", beforeTokens: 120_000 },
  {
    type: "compaction-completed",
    id: "k1",
    summary: "earlier cache work",
    beforeTokens: 120_000,
    afterTokens: 30_000,
    contextScope: "assembled-request",
  },
  {
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
  },
  { type: "assistant-message", text: "The cache holds 3 entries." },
  {
    type: "turn-end",
    outcome: OUTCOME,
    finalAnswer: "The cache holds 3 entries.",
    steps: 1,
  },
];

class TraceAgent implements AgentPort {
  async runTurn(
    _req: RunTurnRequest,
    handlers: RunTurnHandlers,
  ): Promise<TurnOutcome> {
    for (const event of TRACE) handlers.onEvent(event);
    return OUTCOME;
  }
}

function fakePersistence(): PersistencePort {
  return {
    async saveSession() {},
    async loadPlan() {
      return undefined;
    },
    async savePlan() {},
    async deletePlan() {},
  };
}

const caps = detectCapabilities({
  env: {},
  stdoutIsTTY: true,
  stdinIsTTY: true,
  columns: 100,
  rows: 24,
});

const open: AppServices[] = [];

function shell(renderer: "opentui" | "classic"): {
  services: AppServices;
  events: AnyAppEvent[];
} {
  const events: AnyAppEvent[] = [];
  const services = createCompositionRoot({
    agent: new TraceAgent(),
    persistence: fakePersistence(),
    capabilities: caps,
    mode: "agent",
    noHistory: true,
    captureEvents: true,
    updates: {
      check: async () => ({ state: "up-to-date", currentVersion: "0.0.0" }),
    } as AppServices["ports"]["updates"],
    emit: (event) => events.push(event),
  });
  if (renderer === "classic") {
    const wiring = createClassicAppWiring({
      services,
      mouse: false,
      resizeSource: { columns: 100, rows: 24, on: () => undefined, off: () => undefined },
    });
    services.dispose = ((original) => () => {
      wiring.dispose();
      original();
    })(services.dispose.bind(services));
  }
  open.push(services);
  return { services, events };
}

afterEach(() => {
  for (const services of open.splice(0)) services.dispose();
});

interface SemanticFingerprint {
  readonly kinds: readonly string[];
  readonly users: readonly string[];
  readonly assistants: readonly string[];
  readonly thinking: readonly string[];
  readonly tools: readonly string[];
  readonly compacted: readonly string[];
}

function fingerprint(services: AppServices): SemanticFingerprint {
  const items = transcriptItems(services.transcript.getState());
  return {
    kinds: items.map((item) => item.kind),
    users: items.flatMap((item) => (item.kind === "user" ? [item.text] : [])),
    assistants: items.flatMap((item) =>
      item.kind === "assistant" ? [item.text] : [],
    ),
    thinking: items.flatMap((item) =>
      item.kind === "thinking" ? [item.content] : [],
    ),
    tools: items.flatMap((item) =>
      item.kind === "tool" ? [`${item.name}:${item.status}`] : [],
    ),
    compacted: items.flatMap((item) =>
      item.kind === "compacted"
        ? [`${item.beforeTokens}->${item.afterTokens}:${item.summary}`]
        : [],
    ),
  };
}

describe("frontend semantic parity (one canonical trace, three frontends)", () => {
  it("OpenTUI and classic project identical semantic state from the same trace", async () => {
    const opentui = shell("opentui");
    const classic = shell("classic");

    const opentuiResult = await opentui.services.session.submit("audit the cache");
    const classicResult = await classic.services.session.submit("audit the cache");
    expect(opentuiResult.status).toBe("completed");
    expect(classicResult.status).toBe("completed");

    expect(fingerprint(classic.services)).toEqual(fingerprint(opentui.services));
    expect(fingerprint(opentui.services)).toMatchObject({
      users: ["audit the cache"],
      assistants: ["Checking the cache now.", "The cache holds 3 entries."],
      thinking: ["I should inspect the cache first."],
      tools: ["fs.read:ok"],
      compacted: ["120000->30000:earlier cache work"],
    });
  });

  it("both interactive frontends observe the same app event sequence and usage payload", async () => {
    const opentui = shell("opentui");
    const classic = shell("classic");

    await opentui.services.session.submit("audit the cache");
    await classic.services.session.submit("audit the cache");

    const types = (events: readonly AnyAppEvent[]) =>
      events.map((event) => event.type);
    expect(types(classic.events)).toEqual(types(opentui.events));

    const usage = (events: readonly AnyAppEvent[]) =>
      events.find((event) => event.type === "token-usage")?.payload;
    expect(usage(classic.events)).toEqual(usage(opentui.events));
    expect(usage(opentui.events)).toMatchObject({
      cachedPromptTokens: 96,
      cacheCreationTokens: 4,
      uncachedPromptTokens: 20,
      reasoningTokens: 12,
    });
  });

  it("both interactive frontends agree on the shared context snapshot buckets", async () => {
    const opentui = shell("opentui");
    const classic = shell("classic");

    await opentui.services.session.submit("audit the cache");
    await classic.services.session.submit("audit the cache");

    const opentuiSnapshot = opentui.services.session.getState().contextSnapshot;
    const classicSnapshot = classic.services.session.getState().contextSnapshot;
    expect(opentuiSnapshot).toMatchObject({
      scope: "provider-request",
      precision: "provider-exact",
      cache: {
        kind: "reported",
        readTokens: 96,
        creationTokens: 4,
        uncachedTokens: 20,
      },
      reasoning: { kind: "reported", outputTokens: 12 },
    });
    expect(classicSnapshot?.cache).toEqual(opentuiSnapshot?.cache);
    expect(classicSnapshot?.reasoning).toEqual(opentuiSnapshot?.reasoning);
    expect(classicSnapshot?.contextTokens).toBe(opentuiSnapshot?.contextTokens);
  });

  it("noninteractive surfaces the same semantic facts through its output adapter", () => {
    const out = fakeStream(false);
    const err = fakeStream(false);
    const renderer = new StreamRenderer(
      {
        out,
        err,
        columns: 100,
        color: false,
        unicode: true,
        verbosity: "verbose",
        showThinking: true,
      },
      fakeClock(),
    );
    for (const event of TRACE) renderer.handle(event);
    renderer.finish(OUTCOME);

    const stdout = out.text();
    const stderr = err.text();

    expect(stdout).toContain("Checking the cache now.");
    expect(stdout).toContain("The cache holds 3 entries.");

    expect(stderr).toContain("fs.read");
    expect(stderr).toContain("done");
    expect(stderr).toContain("compacted context");
    expect(stderr).toContain("~120,000 → ~30,000 tokens");
    expect(stderr).toContain("96 cached");
    expect(stderr).toContain("4 cache-write");
    expect(stderr).toContain("12 reasoning");
  });
});
