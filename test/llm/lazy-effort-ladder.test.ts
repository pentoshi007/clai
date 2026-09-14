import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearModelCatalogFacts,
  clearReasoningUnsupported,
  displayReasoningEfforts,
  resetReasoningKnowledge,
} from "../../src/llm/capabilities.js";
import { lowestReasoningPreference } from "../../src/llm/lowest-reasoning.js";
import { completeWithProvider } from "../../src/llm/router.js";
import { installTransport } from "../conformance/fake-transport.js";
import { jsonResponse } from "../conformance/wire-fixtures.js";
import { resetResponsesWireStatesForTesting } from "../../src/llm/wire/responses-first.js";
import { resetEffortPreflightForTesting } from "../../src/llm/wire/effort-preflight.js";
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

const FULL_SCALE = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

function ok(): Response {
  return jsonResponse({
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
  });
}

function rejected(message: string): Response {
  return jsonResponse({ error: { message } }, 400);
}

function sentEffort(body: unknown): unknown {
  return (body as Record<string, unknown>)["reasoning_effort"];
}

function chatSends(generations: { url: string; body: unknown }[]) {
  return generations.filter((generation) =>
    generation.url.includes("/chat/completions"),
  );
}

afterEach(() => {
  clearReasoningUnsupported();
  clearModelCatalogFacts();
  resetReasoningKnowledge();
  resetResponsesWireStatesForTesting();
  resetEffortPreflightForTesting();
  vi.unstubAllGlobals();
});

describe("session effort preflight on the request path", () => {
  it("spends one short probe on a cold route, then sends the requested effort", async () => {
    const transport = installTransport((record) => {
      if (record.url.endsWith("/responses")) {
        return jsonResponse({ error: { message: "not found" } }, 404);
      }
      return ok();
    });

    const result = await completeWithProvider({
      provider: "bynara",
      model: "glm-5.3",
      messages,
      purpose: "turn",
      thinking: { enabled: true, effort: "max" },
    });

    expect(result.text).toBe("ok");
    const sends = chatSends(transport.generations);
    expect(sends).toHaveLength(2);
    const probe = sends[0]!.body as Record<string, unknown>;
    expect(probe.messages).toEqual([
      { role: "user", content: "Reply with exactly: ok" },
    ]);
    expect(probe.max_tokens ?? probe.max_completion_tokens).toBeLessThanOrEqual(16);
    expect(probe.tools).toBeUndefined();
    expect(sentEffort(probe)).toBe("max");
    expect(sentEffort(sends[1]!.body)).toBe("max");
    expect(displayReasoningEfforts("bynara", "glm-5.3")).toEqual(FULL_SCALE);
  });

  it("does not probe again once the route has settled", async () => {
    const transport = installTransport((record) => {
      if (record.url.endsWith("/responses")) {
        return jsonResponse({ error: { message: "not found" } }, 404);
      }
      return ok();
    });

    await completeWithProvider({
      provider: "bynara",
      model: "glm-5.3",
      messages,
      purpose: "turn",
      thinking: { enabled: true, effort: "max" },
    });
    const before = chatSends(transport.generations).length;

    await completeWithProvider({
      provider: "bynara",
      model: "glm-5.3",
      messages,
      purpose: "turn",
      thinking: { enabled: true, effort: "high" },
    });

    expect(chatSends(transport.generations).length - before).toBe(1);
  });

  it("settles the ceiling the probe found and clamps later requests to it", async () => {
    let calls = 0;
    let realBody: Record<string, unknown> | undefined;
    installTransport((record) => {
      if (record.url.endsWith("/responses")) {
        return jsonResponse({ error: { message: "not found" } }, 404);
      }
      calls += 1;
      if (calls <= 2) return rejected("reasoning_effort 'high' is not supported");
      realBody = record.body as Record<string, unknown>;
      return ok();
    });

    const first = await completeWithProvider({
      provider: "bynara",
      model: "glm-5.3",
      messages,
      purpose: "turn",
      thinking: { enabled: true, effort: "max" },
    });
    expect(first.text).toBe("ok");
    expect(calls).toBe(4);
    expect(displayReasoningEfforts("bynara", "glm-5.3")).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(sentEffort(realBody)).toBe("high");
  });

  it("climbs from none once for a subagent and keeps the floor", async () => {
    let calls = 0;
    installTransport((record) => {
      if (record.url.endsWith("/responses")) {
        return jsonResponse({ error: { message: "not found" } }, 404);
      }
      calls += 1;
      if (calls === 1) {
        return rejected(
          "This model always engages in thinking and thinking cannot be disabled",
        );
      }
      return ok();
    });

    const first = await completeWithProvider({
      provider: "bynara",
      model: "glm-5.3",
      messages,
      thinking: lowestReasoningPreference("bynara", "glm-5.3"),
    });
    expect(first.text).toBe("ok");
    expect(calls).toBe(3);
    expect(displayReasoningEfforts("bynara", "glm-5.3")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);

    calls = 0;
    let floorBody: Record<string, unknown> | undefined;
    installTransport((record) => {
      if (record.url.endsWith("/responses")) {
        return jsonResponse({ error: { message: "not found" } }, 404);
      }
      calls += 1;
      floorBody = record.body as Record<string, unknown>;
      return ok();
    });
    const second = await completeWithProvider({
      provider: "bynara",
      model: "glm-5.3",
      messages,
      thinking: lowestReasoningPreference("bynara", "glm-5.3"),
    });
    expect(second.text).toBe("ok");
    expect(calls).toBe(1);
    expect(sentEffort(floorBody)).toBe("low");
  });
});
