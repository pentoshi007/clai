import { afterEach, describe, expect, it } from "vitest";
import {
  clearReasoningUnsupported,
  markReasoningUnsupported,
  resetReasoningKnowledge,
} from "../../src/llm/capabilities.js";
import { buildResponsesBody } from "../../src/llm/responses-request.js";
import type { ResponsesDialectConfig } from "../../src/llm/responses-config.js";

const config: ResponsesDialectConfig = {
  baseUrl: "https://example.test/v1",
  providerId: "openai",
  displayName: "Test responses",
  artifactDialect: "openai-compatible",
  terminalPolicy: {
    proofs: ["response-completed", "response-incomplete"],
    naturalEofAccepted: false,
  },
  buildHeaders: () => ({ "content-type": "application/json" }),
  reasoningPayload: (reasoning) =>
    reasoning?.enabled ? { effort: reasoning.effort } : undefined,
  bodyExtras: () => ({}),
};

const messages = [{ role: "user" as const, content: "hi" }];

function bodyFor(model: string): {
  reasoning?: { effort?: string };
} {
  return JSON.parse(
    buildResponsesBody(config, {
      model,
      messages,
      stream: false,
      reasoning: { enabled: true, effort: "high" },
    }),
  ) as { reasoning?: { effort?: string } };
}

afterEach(() => {
  clearReasoningUnsupported();
  resetReasoningKnowledge();
});

describe("Responses wire control resolution", () => {
  it("omits the reasoning payload when the route rejected reasoning controls", () => {
    markReasoningUnsupported("openai", "gpt-4.1-mini");
    const body = bodyFor("gpt-4.1-mini");
    expect(body.reasoning).toBeUndefined();
  });

  it("keeps the reasoning payload when the route accepts reasoning controls", () => {
    const body = bodyFor("gpt-5.1");
    expect(body.reasoning?.effort).toBe("high");
  });
});
