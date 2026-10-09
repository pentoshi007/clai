import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentTurn } from "../../src/agent/runner.js";
import { createSessionPolicy } from "../../src/agent/session-policy.js";
import type { AgentEvent } from "../../src/agent/events.js";
import { getConfig, updateConfig } from "../../src/store/config.js";
import type { ChatMessage, ProviderId } from "../../src/types.js";
import { installTransport, type RecordedRequest } from "../conformance/fake-transport.js";
import { ANSWER_TEXT, buildWireResponse, jsonResponse } from "../conformance/wire-fixtures.js";
import { resetResponsesWireStatesForTesting } from "../../src/llm/wire/responses-first.js";

vi.mock("../../src/commands/providers.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/commands/providers.js")>(),
  ensureProviderConfigured: async () => undefined,
}));

vi.mock("../../src/store/keys.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/store/keys.js")>(),
  getProviderKeys: async (provider: ProviderId) => ({
    keys: provider === "free" ? [{ id: "keyless", value: "", createdAt: 0 }] : [],
    activeIndex: 0,
    source: "local" as const,
  }),
  getProviderSecret: async () => ({ value: "", source: "local" as const }),
}));

const UNAVAILABLE = {
  error: {
    type: "server_error",
    message: "Upstream request failed: Endpoint is unavailable.",
  },
};

const MODEL = "step-5-preview-free";
const PROMPT = "Continue checking the previously recorded findings.";
const HISTORY: ChatMessage[] = [
  { role: "user", content: "Keep the investigation findings." },
  { role: "assistant", content: "The configuration and source files were already checked." },
];

function installProvider(respond: (request: RecordedRequest) => Response) {
  const requests: RecordedRequest[] = [];
  installTransport((request) => {
    if (!JSON.stringify(request.body).includes(PROMPT)) {
      return buildWireResponse("meta_responses", "stream", "reasoning", MODEL);
    }
    requests.push(request);
    return respond(request);
  });
  return requests;
}

function startTurn(model = MODEL, signal?: AbortSignal) {
  const events: AgentEvent[] = [];
  let history: ChatMessage[] = [];
  const result = runAgentTurn(PROMPT, {
    provider: "free",
    model,
    session: createSessionPolicy(`free-rate-limit-${model}`),
    history: structuredClone(HISTORY),
    maxSteps: 1,
    toolCalling: "native",
    signal,
    onEvent: (event) => events.push(event),
    onMessages: (messages) => { history = messages; },
  }).then(
    (outcome) => ({ outcome }),
    (error: unknown) => ({ error }),
  );
  return { events, result, history: () => history };
}

async function waitForRetry(events: AgentEvent[], seconds: number) {
  await vi.waitFor(() => {
    expect(events).toContainEqual({
      type: "status",
      text: `retrying in ${seconds}s (rate-limit)`,
    });
  });
}

const configBefore = getConfig();

beforeEach(() => {
  updateConfig({ providerFallback: false, freeOnly: true });
  resetResponsesWireStatesForTesting();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  updateConfig({
    providerFallback: configBefore.providerFallback,
    freeOnly: configBefore.freeOnly,
  });
});

describe("Free rate-limit recovery through the agent and HTTP router", () => {
  it.each([MODEL, "free-2/stepfun/step-3.7-flash:free"])(
    "recovers %s from upstream-unavailable 429 responses without changing the request prefix",
    async (model) => {
      let failures = 2;
      const requests = installProvider((request) => {
        if (failures-- > 0) return jsonResponse(UNAVAILABLE, 429);
        const family = request.url.endsWith("/responses") ? "meta_responses" : "chat_completions";
        return buildWireResponse(family, "stream", "answer", model);
      });
      const turn = startTurn(model);

      await waitForRetry(turn.events, 5);
      expect(requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_000);
      await waitForRetry(turn.events, 8);
      expect(requests).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(8_000);

      const result = await turn.result;
      expect(result).toMatchObject({ outcome: { answer: ANSWER_TEXT } });
      expect(requests).toHaveLength(3);
      expect(requests.map((request) => request.body)).toEqual([
        requests[0]!.body,
        requests[0]!.body,
        requests[0]!.body,
      ]);
      if (model === MODEL) {
        expect(new Set(requests.map((request) => request.headers["x-opencode-session"])).size).toBe(1);
        expect(requests[0]!.headers["x-opencode-session"]).toBeTruthy();
      }
      expect(turn.history()).toEqual(expect.arrayContaining(HISTORY));
      expect(turn.history().filter((message) => message.content === PROMPT)).toHaveLength(1);
      expect(turn.events.filter((event) => event.type === "turn-error")).toHaveLength(0);
    },
  );

  it("stops after four visible retry waits and retains the previous conversation", async () => {
    const requests = installProvider(() => jsonResponse(UNAVAILABLE, 429));
    const turn = startTurn();

    for (const [index, seconds] of [5, 8, 10, 15].entries()) {
      await waitForRetry(turn.events, seconds);
      expect(requests).toHaveLength(index + 1);
      await vi.advanceTimersByTimeAsync(seconds * 1_000);
    }

    const result = await turn.result;
    expect(result).toMatchObject({ error: { status: 429 } });
    expect(String("error" in result ? result.error : "")).toContain(UNAVAILABLE.error.message);
    expect(requests).toHaveLength(5);
    expect(turn.history()).toEqual(expect.arrayContaining(HISTORY));
    expect(turn.history().filter((message) => message.content === PROMPT)).toHaveLength(1);
    expect(turn.events.filter((event) => event.type === "turn-error")).toHaveLength(1);
  });

  it("cancels a retry wait without dispatching another request", async () => {
    const requests = installProvider(() => jsonResponse(UNAVAILABLE, 429));
    const abort = new AbortController();
    const turn = startTurn(MODEL, abort.signal);

    await waitForRetry(turn.events, 5);
    abort.abort();
    expect(await turn.result).toMatchObject({ outcome: { status: "aborted" } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests).toHaveLength(1);
    expect(turn.history()).toEqual(expect.arrayContaining(HISTORY));
  });

  it("does not retry a 429 that explicitly reports insufficient account quota", async () => {
    const requests = installProvider(() => jsonResponse({
      error: { type: "insufficient_quota", message: "You exceeded your current quota, please check your plan and billing details." },
    }, 429));
    const turn = startTurn();

    expect(await turn.result).toMatchObject({ error: { status: 429 } });
    expect(requests).toHaveLength(1);
    expect(turn.events.filter((event) => event.type === "status" && event.text.startsWith("retrying in"))).toHaveLength(0);
  });
});
