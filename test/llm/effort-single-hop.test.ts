import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearModelCatalogFacts,
  clearReasoningUnsupported,
  resetReasoningKnowledge,
} from "../../src/llm/capabilities.js";
import {
  completeWithProvider,
  effortCandidatesFor,
} from "../../src/llm/router.js";
import { installTransport } from "../conformance/fake-transport.js";
import { jsonResponse } from "../conformance/wire-fixtures.js";
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

const EFFORT_REJECTED = {
  error: { message: "reasoning_effort must be one of low, high, max" },
};

afterEach(() => {
  clearReasoningUnsupported();
  clearModelCatalogFacts();
  resetReasoningKnowledge();
  vi.unstubAllGlobals();
});

function effortOf(body: unknown): unknown {
  const parsed = body as Record<string, unknown>;
  if (parsed["reasoning_effort"] !== undefined) return parsed["reasoning_effort"];
  const nested = parsed["reasoning"];
  if (nested && typeof nested === "object") {
    return (nested as Record<string, unknown>)["effort"];
  }
  return undefined;
}

describe("a route with a declared effort vocabulary takes one hop, not a ladder", () => {
  it("retries without re-sending a payload the emitter already chose", async () => {
    let chatCalls = 0;
    const transport = installTransport((record) => {
      if (record.url.endsWith("/responses")) {
        return new Response("not found", { status: 404 });
      }
      chatCalls += 1;
      if (chatCalls === 1) return jsonResponse(EFFORT_REJECTED, 400);
      return jsonResponse({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      });
    });

    const result = await completeWithProvider({
      provider: "tokenrouter",
      model: "moonshotai/kimi-k3",
      messages,
      thinking: { enabled: true, effort: "medium" },
    });

    expect(result.text).toBe("ok");
    const chatGenerations = transport.generations.filter((generation) =>
      generation.url.includes("/chat/completions"),
    );
    expect(chatGenerations).toHaveLength(2);
    expect(effortOf(chatGenerations[0]?.body)).toBe("high");
    expect(effortOf(chatGenerations[1]?.body)).toBeUndefined();
  });

  it("gives up after that single hop instead of walking the whole scale", async () => {
    const transport = installTransport(() => jsonResponse(EFFORT_REJECTED, 400));

    await expect(
      completeWithProvider({
        provider: "tokenrouter",
        model: "moonshotai/kimi-k3",
        messages,
        thinking: { enabled: true, effort: "medium" },
      }),
    ).rejects.toThrow();

    expect(transport.generations.length).toBeLessThanOrEqual(3);
  });

  it("never spends a retry re-sending the payload the emitter already chose", async () => {
    const transport = installTransport(() => jsonResponse(EFFORT_REJECTED, 400));

    await expect(
      completeWithProvider({
        provider: "tokenrouter",
        model: "moonshotai/kimi-k3",
        messages,
        thinking: { enabled: true, effort: "xhigh" },
      }),
    ).rejects.toThrow();

    const efforts = transport.generations
      .map((generation) => effortOf(generation.body))
      .filter((effort) => effort !== undefined);
    expect(efforts[0]).toBe("max");
    expect(new Set(efforts).size).toBe(efforts.length);
  });
});

describe("a 5xx only enters reasoning adaptation when it mentions reasoning", () => {
  it("does not treat a bare TokenRouter 5xx as a reasoning rejection", async () => {
    let calls = 0;
    installTransport(() => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({ error: { message: "upstream unavailable" } }, 503);
      }
      return jsonResponse({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      });
    });

    const result = await completeWithProvider({
      provider: "tokenrouter",
      model: "moonshotai/kimi-k3",
      messages,
      thinking: { enabled: true, effort: "high" },
    });

    expect(result.text).toBe("ok");
  });
});

describe("candidate selection", () => {
  it("offers exactly one hop when the route declares a vocabulary", () => {
    expect(
      effortCandidatesFor("tokenrouter", "moonshotai/kimi-k3", "medium"),
    ).toEqual(["high"]);
  });

  it("steps down one rung when the declared vocabulary contains the request", () => {
    expect(effortCandidatesFor("tokenrouter", "moonshotai/kimi-k3", "high")).toEqual(
      ["low"],
    );
  });

  it("falls back to the full ladder when the route declares nothing", () => {
    const candidates = effortCandidatesFor(
      "ollama",
      "llama3.1:8b",
      "max",
    );
    expect(candidates.length).toBeGreaterThan(1);
  });

  it("keeps the ladder ordered from the request downward for unknown routes", () => {
    const candidates = effortCandidatesFor("ollama", "llama3.1:8b", "max");
    expect(candidates[0]).not.toBe("max");
    expect(candidates).toEqual(["xhigh", "high"]);
  });
});
