import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearReasoningUnsupported,
  isReasoningUnsupported,
  markReasoningUnsupported,
  resetReasoningKnowledge,
  routeReasoningIsMandatory,
} from "../../src/llm/capabilities.js";
import { streamWithProvider } from "../../src/llm/router.js";
import { installTransport } from "../conformance/fake-transport.js";
import { jsonResponse, textStreamResponse } from "../conformance/wire-fixtures.js";
import type { ChatMessage } from "../../src/types.js";

vi.mock("../../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async (provider: string) => ({
      keys: [{ id: "env", value: `sk-${provider}-testkey`, createdAt: 0 }],
      activeIndex: 0,
      source: "env" as const,
    }),
  };
});

const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
const MODEL = "free-1/x-preview-f-free";

const MANDATORY_1210 = {
  error: {
    type: "server_error",
    message:
      "Error from provider (Console): Upstream request failed: [1210] This model " +
      "always engages in thinking and cannot be disabled; please use low, high, or max",
  },
};

const ACCEPTED = new Set(["low", "high", "max"]);

function okStream(): Response {
  return textStreamResponse([
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "hm" } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: "ok" } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
    "data: [DONE]\n\n",
  ]);
}

function gatewayThatOnlyAcceptsLowHighMax(): ReturnType<typeof installTransport> {
  return installTransport((req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const effort = body["reasoning_effort"];
    if (effort === undefined) return okStream();
    if (typeof effort === "string" && ACCEPTED.has(effort)) return okStream();
    return jsonResponse(MANDATORY_1210, 400);
  });
}

const effortsOf = (t: ReturnType<typeof installTransport>): unknown[] =>
  t.generations.map((g) => (g.body as Record<string, unknown>)["reasoning_effort"]);

beforeEach(() => {
  resetReasoningKnowledge();
});

afterEach(() => {
  clearReasoningUnsupported();
  resetReasoningKnowledge();
  vi.unstubAllGlobals();
});

describe("a free model that mandates thinking", () => {
  it("recovers the turn instead of failing it", async () => {
    const transport = gatewayThatOnlyAcceptsLowHighMax();
    const tokens: string[] = [];

    const result = await streamWithProvider(
      {
        provider: "free",
        model: MODEL,
        messages,
        thinking: { enabled: true, effort: "max" },
      },
      (token) => tokens.push(token),
    );

    expect(result.text).toContain("ok");
    const efforts = effortsOf(transport);
    expect(ACCEPTED.has(String(efforts.at(-1)))).toBe(true);
  });

  it("learns the contract so it is not marked reasoning-unsupported", async () => {
    gatewayThatOnlyAcceptsLowHighMax();
    await streamWithProvider(
      {
        provider: "free",
        model: MODEL,
        messages,
        thinking: { enabled: true, effort: "medium" },
      },
      () => {},
    );

    expect(routeReasoningIsMandatory("free", MODEL)).toBe(true);
    expect(isReasoningUnsupported("free", MODEL)).toBe(false);
  });

  it("still succeeds when the route was already poisoned as unsupported", async () => {
    markReasoningUnsupported("free", MODEL);
    const transport = gatewayThatOnlyAcceptsLowHighMax();

    const result = await streamWithProvider(
      {
        provider: "free",
        model: MODEL,
        messages,
        thinking: { enabled: true, effort: "max" },
      },
      () => {},
    );

    expect(result.text).toContain("ok");
    expect(transport.generations.length).toBeGreaterThan(0);
  });

  it("sends only accepted efforts on the following turn", async () => {
    gatewayThatOnlyAcceptsLowHighMax();
    await streamWithProvider(
      { provider: "free", model: MODEL, messages, thinking: { enabled: true, effort: "xhigh" } },
      () => {},
    );

    const second = gatewayThatOnlyAcceptsLowHighMax();
    const result = await streamWithProvider(
      { provider: "free", model: MODEL, messages, thinking: { enabled: true, effort: "xhigh" } },
      () => {},
    );

    expect(result.text).toContain("ok");
    expect(second.generations).toHaveLength(1);
    for (const effort of effortsOf(second)) {
      if (effort !== undefined) expect(ACCEPTED.has(String(effort))).toBe(true);
    }
  });
});
