import { describe, expect, it } from "vitest";
import { ProviderError } from "../../src/llm/http.js";
import { mentionsReasoning } from "../../src/llm/reasoning-errors.js";
import {
  effortCandidatesFor,
  shouldContinueEffortLadder,
  shouldEnterEffortLadder,
} from "../../src/llm/routing/error-classification.js";
import {
  isReasoningUnsupportedError,
  reasoningRejectionAdvice,
} from "../../src/llm/wire/capability-errors.js";

const GLM_LIVE_MESSAGE =
  "该模型始终思考,不支持关闭思考;请使用 low、high 或 max。";

function glmError(): ProviderError {
  return new ProviderError(
    `AgentRouter (model=glm-5.3): Provider request failed with HTTP 400 — ${GLM_LIVE_MESSAGE}`,
    400,
    `{"error":{"message":"${GLM_LIVE_MESSAGE}","type":"invalid_request_error"}}`,
  );
}

describe("chinese reasoning-control rejection recognition", () => {
  it("classifies the live glm-5.3 400 as a reasoning-unsupported error", () => {
    expect(isReasoningUnsupportedError(glmError())).toBe(true);
    expect(shouldContinueEffortLadder(glmError())).toBe(true);
    expect(mentionsReasoning(glmError())).toBe(true);
  });

  it("extracts mandatory plus the accepted effort vocabulary from the advice", () => {
    expect(reasoningRejectionAdvice(glmError())).toEqual({
      mandatory: true,
      acceptedEfforts: ["low", "high", "max"],
    });
  });

  it("enters the reactive ladder and climbs from a rejected none request", () => {
    expect(
      shouldEnterEffortLadder(
        glmError(),
        { enabled: false, effort: "none" },
        "agentrouter",
        "glm-5.3",
        false,
      ),
    ).toBe(true);
    expect(effortCandidatesFor("agentrouter", "glm-5.3", "none")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("still recognizes the English vocabulary clause", () => {
    const error = new ProviderError(
      "Gateway: request failed",
      400,
      '{"error":{"message":"reasoning_effort must be one of low, medium"}}',
    );
    expect(reasoningRejectionAdvice(error)).toEqual({
      mandatory: false,
      acceptedEfforts: ["low", "medium"],
    });
  });

  it("does not treat unrelated chinese 400s as reasoning rejections", () => {
    const error = new ProviderError(
      "Gateway: request failed",
      400,
      '{"error":{"message":"请求参数无效,请检查输入"}}',
    );
    expect(isReasoningUnsupportedError(error)).toBe(false);
    expect(mentionsReasoning(error)).toBe(false);
    expect(reasoningRejectionAdvice(error)).toBeUndefined();
  });
});
