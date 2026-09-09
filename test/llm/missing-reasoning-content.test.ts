import { describe, expect, it } from "vitest";

import {
  isInvalidReasoningContentError,
  isMissingReasoningContentError,
  mentionsReasoning,
} from "../../src/llm/reasoning-errors.js";
import {
  ProviderError,
  isReasoningUnsupportedError,
} from "../../src/llm/http.js";
import { isEffortRejectedError } from "../../src/llm/effort-fallback.js";

function providerError(status: number, body: string): ProviderError {
  const error = new ProviderError(`request failed with ${status}`);
  (error as { status?: number }).status = status;
  (error as { body?: string }).body = body;
  return error;
}

const DEEPSEEK_400 = JSON.stringify({
  error: {
    message:
      "The reasoning_content of the last assistant message must be passed back for reasoning models.",
    type: "invalid_request_error",
    code: "invalid_request_error",
  },
});

const UNSUPPORTED_400 = JSON.stringify({
  error: { message: "Unrecognized request argument supplied: reasoning_effort" },
});

describe("a missing-reasoning_content rejection is not an unsupported-reasoning rejection", () => {
  it("classifies DeepSeek's literal 400 body as missing reasoning content", () => {
    expect(isMissingReasoningContentError(providerError(400, DEEPSEEK_400))).toBe(
      true,
    );
  });

  it("does not route that body into the unsupported classifier", () => {
    expect(isReasoningUnsupportedError(providerError(400, DEEPSEEK_400))).toBe(
      false,
    );
  });

  it("does not route that body into the effort classifier", () => {
    expect(isEffortRejectedError(providerError(400, DEEPSEEK_400))).toBe(false);
  });

  it("still classifies a genuine parameter rejection as unsupported", () => {
    const error = providerError(400, UNSUPPORTED_400);
    expect(isMissingReasoningContentError(error)).toBe(false);
    expect(isReasoningUnsupportedError(error)).toBe(true);
  });

  it.each(["thinking signature verification failed", "Invalid thinking signature"])("recognizes an invalid signed continuation without treating controls as unsupported: %s", (message) => {
    const error = providerError(
      400,
      JSON.stringify({ error: { message } }),
    );
    expect(isInvalidReasoningContentError(error)).toBe(true);
    expect(isReasoningUnsupportedError(error)).toBe(false);
    expect(isEffortRejectedError(error)).toBe(false);
  });

  it("does not confuse a missing continuation with an invalid one", () => {
    expect(isInvalidReasoningContentError(providerError(400, DEEPSEEK_400))).toBe(
      false,
    );
  });

  it("recognizes the exact ExLabs authenticity rejection without an error envelope", () => {
    const error = providerError(400, "'messages.reasoning_content' must be an authentic continuation for this route.");
    expect(isInvalidReasoningContentError(error)).toBe(true);
    expect(isReasoningUnsupportedError(error)).toBe(false);
    expect(isEffortRejectedError(error)).toBe(false);
  });

  it.each(["Invalid enable_thinking value", "thinking.budget_tokens is invalid", "Invalid reasoning_effort"])("does not confuse control rejection with replay rejection: %s", (body) => {
    const error = providerError(400, body);
    expect(isInvalidReasoningContentError(error)).toBe(false);
    expect(isReasoningUnsupportedError(error)).toBe(true);
  });

  it("matches the other phrasings gateways use", () => {
    for (const body of [
      "reasoning content must be sent back with the assistant turn",
      "missing reasoning_content on assistant message",
      "reasoning_content is required for this model",
      "The reasoning_content of the previous turn must be provided back.",
    ]) {
      expect(isMissingReasoningContentError(providerError(400, body))).toBe(true);
    }
  });

  it("matches the reasoning_text phrasing used by AgentRouter's thinking models", () => {
    const body = JSON.stringify({
      error: {
        message:
          "The `reasoning_text` in the thinking mode must be passed back to the API. [trace_id=abc123]",
        type: "invalid_request_error",
        param: "",
        code: null,
      },
    });
    const error = providerError(400, body);
    expect(isMissingReasoningContentError(error)).toBe(true);
    expect(isReasoningUnsupportedError(error)).toBe(false);
    expect(isEffortRejectedError(error)).toBe(false);
  });

  it("ignores a 5xx that merely mentions reasoning", () => {
    expect(
      isMissingReasoningContentError(
        providerError(503, "reasoning_content must be passed back"),
      ),
    ).toBe(false);
  });

  it("recognizes reasoning mentions separately from the missing-content case", () => {
    expect(mentionsReasoning(providerError(500, "upstream reasoning failure"))).toBe(
      true,
    );
    expect(mentionsReasoning(providerError(500, "gateway timeout"))).toBe(false);
  });
});
