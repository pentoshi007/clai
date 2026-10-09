import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/llm/http.js";
import {
  isImmediateKeySwitchError,
  isKeyRotatableError,
  isQuotaKeyError,
} from "../src/llm/key-rotation.js";
import {
  isHardQuotaError,
  mentionsQuotaExhaustion,
  mentionsRateLimit,
  providerErrorText,
} from "../src/llm/quota-signals.js";
import { isRateLimited } from "../src/llm/routing/error-classification.js";
import { formatProviderFailureForUser } from "../src/llm/routing/failure-report.js";

const qwenQuotaError = (): ProviderError =>
  new ProviderError(
    "Qwen Cloud stream error: The free quota has been exhausted. To continue accessing the model on a paid basis, please complete your payment information.",
    undefined,
    '{"type":"response.failed","response":{"error":{"message":"The free quota has been exhausted.","code":"server_error"},"status":"failed"}}',
  );

describe("providerErrorText", () => {
  it("combines message and body for ProviderError", () => {
    const text = providerErrorText(new ProviderError("msg", undefined, "body"));
    expect(text).toBe("msg\nbody");
  });

  it("handles plain errors and junk", () => {
    expect(providerErrorText(new Error("plain"))).toBe("plain");
    expect(providerErrorText("str")).toBe("str");
    expect(providerErrorText(undefined)).toBe("");
  });
});

describe("isHardQuotaError", () => {
  it.each([
    new ProviderError("payment required", 402),
    new ProviderError("too many requests", 429, '{"error":{"type":"insufficient_quota"}}'),
    new Error("You exceeded your current quota, please check your plan and billing details"),
    new Error("credit balance is too low to run this request"),
  ])("identifies account limits without waiting for a rate reset: %s", (error) => {
    expect(isHardQuotaError(error)).toBe(true);
  });

  it.each([
    new ProviderError("Upstream request failed: Endpoint is unavailable.", 429),
    new Error("Requests per minute quota exceeded"),
    new Error("Resource has been exhausted, retry after 10s"),
    new Error("Too many requests"),
  ])("keeps transient capacity and request quotas separate: %s", (error) => {
    expect(isHardQuotaError(error)).toBe(false);
  });
});

describe("mentionsQuotaExhaustion", () => {
  it("detects qwen-style free quota exhaustion without a 429 status", () => {
    const error = qwenQuotaError();
    expect(mentionsQuotaExhaustion(error)).toBe(true);
    expect(isQuotaKeyError(error)).toBe(true);
    expect(isImmediateKeySwitchError(error)).toBe(true);
    expect(isKeyRotatableError(error, () => false)).toBe(true);
  });

  it("detects common provider quota phrases in message or body", () => {
    const cases = [
      new Error("You exceeded your current quota, please check your plan and billing details"),
      new ProviderError("bad request", 400, '{"error":{"code":"insufficient_quota"}}'),
      new ProviderError("forbidden", 403, "Resource has been exhausted (e.g. check quota)."),
      new Error("credit balance is too low to run this request"),
      new Error("usage limit reached for this period"),
      new ProviderError("server error", 500, "The free quota has been exhausted."),
    ];
    for (const error of cases) {
      expect(mentionsQuotaExhaustion(error), providerErrorText(error)).toBe(true);
    }
  });

  it("does not flag unrelated errors", () => {
    expect(mentionsQuotaExhaustion(new Error("file not found"))).toBe(false);
    expect(mentionsQuotaExhaustion(new ProviderError("invalid argument x", 400))).toBe(false);
    expect(
      mentionsQuotaExhaustion(new Error("the docs mention quota as a concept")),
    ).toBe(false);
  });
});

describe("mentionsRateLimit / isRateLimited", () => {
  it("keeps 429 status detection", () => {
    expect(isRateLimited(new ProviderError("slow down", 429))).toBe(true);
  });

  it("detects rate limiting from body or message without 429", () => {
    expect(
      isRateLimited(
        new ProviderError("bad request", 400, '{"error":{"type":"rate_limit_exceeded"}}'),
      ),
    ).toBe(true);
    expect(isRateLimited(new Error("Too many requests, retry later"))).toBe(true);
    expect(mentionsRateLimit(new Error("Rate limit reached for gpt-4o"))).toBe(true);
  });

  it("treats quota exhaustion as rotatable rate limiting", () => {
    expect(isRateLimited(qwenQuotaError())).toBe(true);
  });

  it("does not flag unrelated errors", () => {
    expect(isRateLimited(new ProviderError("nope", 401))).toBe(false);
    expect(isRateLimited(new Error("syntax error near limit"))).toBe(false);
  });
});

describe("formatProviderFailureForUser", () => {
  it("guides on status-less quota exhaustion", () => {
    const text = formatProviderFailureForUser(qwenQuotaError());
    expect(text).toMatch(/quota\/credits/i);
    expect(text).toMatch(/another API key|switch provider/i);
  });

  it("guides on status-less rate limiting", () => {
    const text = formatProviderFailureForUser(
      new ProviderError("gateway said: too many requests right now"),
    );
    expect(text).toMatch(/rate limited/i);
  });

  it("keeps the classic 429 guidance", () => {
    const text = formatProviderFailureForUser(new ProviderError("boom", 429));
    expect(text).toMatch(/rate limited \(429\)/i);
  });

  it("reports insufficient account quota even when the status is 429", () => {
    const text = formatProviderFailureForUser(new ProviderError(
      "insufficient_quota",
      429,
      '{"error":{"code":"insufficient_quota"}}',
    ));
    expect(text).toContain("quota/credits are exhausted (429)");
    expect(text).toContain("Exact provider error: insufficient_quota");
    expect(text).toContain('"code":"insufficient_quota"');
  });
});
