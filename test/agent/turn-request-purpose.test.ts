import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildStreamRequest } from "../../src/agent/turn/loop/stream-request.js";
import { displayReasoningEfforts, resetReasoningKnowledge } from "../../src/llm/capabilities.js";
import { openAiCompatibleComplete } from "../../src/llm/http.js";
import { withRequestPurpose } from "../../src/llm/request-purpose.js";
import { resetResponsesWireStatesForTesting } from "../../src/llm/wire/responses-first.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  resetResponsesWireStatesForTesting();
  resetReasoningKnowledge();
});

afterEach(() => {
  resetResponsesWireStatesForTesting();
  resetReasoningKnowledge();
  vi.unstubAllGlobals();
});

describe("main-agent turn purpose", () => {
  it("tags every turn request with purpose 'turn'", () => {
    const request = buildStreamRequest({
      provider: "agentrouter",
      model: "glm-5.3",
      messages: [{ role: "user", content: "hi" }],
      allowModelFallback: false,
      preferModelFallback: false,
      maxTokens: 1024,
      signal: undefined,
      thinking: { enabled: true, effort: "medium" },
      retryWithoutThinking: false,
      toolsAttached: false,
      tools: undefined,
      onToolCallDelta: () => {},
    });
    expect(request.purpose).toBe("turn");
  });

  it("sends the configured effort for a turn without probing other efforts", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      return json({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      });
    }));
    const wire = {
      provider: "AgentRouter",
      providerId: "agentrouter" as const,
      baseUrl: "https://turn-purpose.test/v1",
      apiKey: "test-key",
      model: "glm-5.3",
      messages: [{ role: "user" as const, content: "hi" }],
      reasoningStyle: "agentrouter" as const,
      responsesFirst: false,
      discoverCapabilities: true,
    };
    await withRequestPurpose("turn", () =>
      openAiCompatibleComplete({
        ...wire,
        reasoning: { enabled: true, effort: "medium" },
      }),
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.thinking).toEqual({ type: "enabled" });
    expect(displayReasoningEfforts("agentrouter", "glm-5.3")).toBeUndefined();
  });
});
