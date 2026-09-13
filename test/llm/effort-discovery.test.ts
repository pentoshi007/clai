import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  displayReasoningEfforts,
  resetReasoningKnowledge,
  routeReasoningIsMandatory,
} from "../../src/llm/capabilities.js";
import { openAiCompatibleComplete } from "../../src/llm/http.js";
import { lowestReasoningPreference } from "../../src/llm/lowest-reasoning.js";
import { resetResponsesWireStatesForTesting } from "../../src/llm/wire/responses-first.js";
import {
  resolveEffortForPurpose,
  routeDisableAccepted,
  setEffortDiscoveryEnabledForTesting,
} from "../../src/llm/wire/effort-discovery.js";

const GLM_REJECTION =
  "This model always engages in thinking and thinking cannot be disabled; please use low, high, or max.";

const base = {
  provider: "AgentRouter",
  providerId: "agentrouter" as const,
  baseUrl: "https://discovery.test/v1",
  apiKey: "test-key",
  model: "glm-5.3",
  messages: [{ role: "user" as const, content: "hello" }],
  reasoningStyle: "agentrouter" as const,
  responsesFirst: false,
  discoverCapabilities: true,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function answer(text: string): Response {
  return json({
    choices: [{ message: { content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  });
}

function probeEfforts(): string[] {
  const efforts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if ((body.thinking as { type?: string } | undefined)?.type === "disabled") {
      efforts.push("disabled");
      return json({ error: { message: GLM_REJECTION } }, 400);
    }
    const effort = body.reasoning_effort as string | undefined;
    efforts.push(effort ?? "none");
    if (effort === "low" || effort === "high") return answer("ok");
    return json({ error: { message: GLM_REJECTION } }, 400);
  }));
  return efforts;
}

beforeEach(() => {
  setEffortDiscoveryEnabledForTesting(true);
  resetResponsesWireStatesForTesting();
  resetReasoningKnowledge();
});

afterEach(() => {
  resetResponsesWireStatesForTesting();
  resetReasoningKnowledge();
  vi.unstubAllGlobals();
});

describe("central effort discovery", () => {
  it("probes max-first, registers the accepted ladder, and learns disabling is rejected", async () => {
    const efforts = probeEfforts();
    const result = await openAiCompatibleComplete({
      ...base,
      purpose: "turn",
      reasoning: { enabled: true, effort: "medium" },
    });
    expect(result.text).toBe("ok");
    expect(efforts).toEqual([
      "max",
      "xhigh",
      "high",
      "medium",
      "low",
      "minimal",
      "disabled",
      "high",
    ]);
    expect(displayReasoningEfforts("agentrouter", "glm-5.3")).toEqual([
      "low",
      "high",
    ]);
    expect(routeReasoningIsMandatory("agentrouter", "glm-5.3")).toBe(true);
    expect(routeDisableAccepted("agentrouter", "glm-5.3")).toBe(false);
  });

  it("caches the ladder so the next request probes nothing", async () => {
    const efforts = probeEfforts();
    await openAiCompatibleComplete({
      ...base,
      reasoning: { enabled: true, effort: "medium" },
    });
    const after = efforts.length;
    await openAiCompatibleComplete({
      ...base,
      reasoning: { enabled: true, effort: "high" },
    });
    expect(efforts).toHaveLength(after + 1);
  });

  it("resolves turn requests to the max supported effort and others to the least", async () => {
    probeEfforts();
    await openAiCompatibleComplete({
      ...base,
      reasoning: { enabled: true, effort: "medium" },
    });
    expect(resolveEffortForPurpose("agentrouter", "glm-5.3", "turn")).toEqual({
      enabled: true,
      effort: "high",
    });
    expect(
      resolveEffortForPurpose("agentrouter", "glm-5.3", "compaction"),
    ).toEqual({ enabled: true, effort: "low" });
    expect(
      resolveEffortForPurpose("agentrouter", "glm-5.3", undefined),
    ).toBeUndefined();
    expect(lowestReasoningPreference("agentrouter", "glm-5.3")).toEqual({
      enabled: true,
      effort: "low",
    });
  });

  it("rewrites the wire reasoning by purpose only on discovered routes", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      if ((body.thinking as { type?: string } | undefined)?.type === "disabled") {
        return json({ error: { message: GLM_REJECTION } }, 400);
      }
      const effort = body.reasoning_effort as string | undefined;
      if (effort === "low" || effort === "high") return answer("ok");
      return json({ error: { message: GLM_REJECTION } }, 400);
    }));
    await openAiCompatibleComplete({
      ...base,
      purpose: "turn",
      reasoning: { enabled: true, effort: "medium" },
    });
    const real = bodies[bodies.length - 1]!;
    expect(real.reasoning_effort).toBe("high");
    bodies.length = 0;
    await openAiCompatibleComplete({
      ...base,
      purpose: "compaction",
      reasoning: { enabled: true, effort: "high" },
    });
    expect(bodies[0]!.reasoning_effort).toBe("low");
  });

  it("probes automatically when no capability flag is set and the vocabulary is unknown", async () => {
    const efforts = probeEfforts();
    const result = await openAiCompatibleComplete({
      provider: "AgentRouter",
      providerId: "agentrouter",
      baseUrl: "https://discovery.test/v1",
      apiKey: "test-key",
      model: "glm-5.9",
      messages: [{ role: "user", content: "hello" }],
      reasoningStyle: "agentrouter",
      responsesFirst: false,
      reasoning: { enabled: true, effort: "medium" },
    });
    expect(result.text).toBe("ok");
    expect(efforts[0]).toBe("max");
    expect(displayReasoningEfforts("agentrouter", "glm-5.9")).toEqual([
      "low",
      "high",
    ]);
  });

  it("never probes a route whose effort vocabulary is already declared", async () => {
    const models: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      models.push(String(body.model));
      return answer("ok");
    }));
    await openAiCompatibleComplete({
      provider: "OpenAI",
      providerId: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      model: "gpt-5.2",
      messages: [{ role: "user", content: "hello" }],
      responsesFirst: false,
      reasoning: { enabled: true, effort: "high" },
    });
    expect(models).toEqual(["gpt-5.2"]);
  });
});
