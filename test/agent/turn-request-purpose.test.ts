import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildStreamRequest } from "../../src/agent/turn/loop/stream-request.js";
import { resetReasoningKnowledge } from "../../src/llm/capabilities.js";
import { openAiCompatibleComplete } from "../../src/llm/http.js";
import { withRequestPurpose } from "../../src/llm/request-purpose.js";
import { resetResponsesWireStatesForTesting } from "../../src/llm/wire/responses-first.js";

const GLM_REJECTION =
  "This model always engages in thinking and thinking cannot be disabled; please use low, high, or max.";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
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

  it("resolves a turn carried by request context to the max supported effort", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      if ((body.thinking as { type?: string } | undefined)?.type === "disabled") {
        return json({ error: { message: GLM_REJECTION } }, 400);
      }
      const effort = body.reasoning_effort as string | undefined;
      if (effort === "low" || effort === "high") {
        return json({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        });
      }
      return json({ error: { message: GLM_REJECTION } }, 400);
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
    await openAiCompatibleComplete({
      ...wire,
      reasoning: { enabled: true, effort: "medium" },
    });
    bodies.length = 0;
    await withRequestPurpose("turn", () =>
      openAiCompatibleComplete({
        ...wire,
        reasoning: { enabled: true, effort: "medium" },
      }),
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.reasoning_effort).toBe("high");
  });
});
