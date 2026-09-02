import { describe, expect, it } from "vitest";
import {
  attemptsPerKey,
  buildKeyAttemptPlan,
  formatKeyEventStatus,
  isAuthKeyError,
  isImmediateKeySwitchError,
  isKeyCircleStopError,
  isKeyRotatableError,
  isQuotaKeyError,
  MULTI_KEY_ATTEMPTS,
} from "../../src/llm/key-rotation.js";
import { ProviderError } from "../../src/llm/http.js";

describe("buildKeyAttemptPlan", () => {
  it("returns empty for n=0", () => {
    expect(buildKeyAttemptPlan(0, 0)).toEqual([]);
  });

  it("returns [0] for single key", () => {
    expect(buildKeyAttemptPlan(1, 0)).toEqual([0]);
    expect(buildKeyAttemptPlan(1, 5)).toEqual([0]);
  });

  it("circles from mid start (3-based display → index 2)", () => {
    // keys 0,1,2,3 start at 2 → 2,3,0,1 (display 3,4,1,2)
    expect(buildKeyAttemptPlan(4, 2)).toEqual([2, 3, 0, 1]);
  });

  it("starts at 0 when sticky is 0", () => {
    expect(buildKeyAttemptPlan(3, 0)).toEqual([0, 1, 2]);
  });

  it("normalizes negative start", () => {
    expect(buildKeyAttemptPlan(3, -1)).toEqual([2, 0, 1]);
  });
});

describe("attemptsPerKey", () => {
  it("uses multi attempts for N>=2", () => {
    expect(attemptsPerKey(2, 7)).toBe(MULTI_KEY_ATTEMPTS);
    expect(attemptsPerKey(5, 7)).toBe(2);
  });

  it("uses single-key max for N<=1", () => {
    expect(attemptsPerKey(1, 7)).toBe(7);
    expect(attemptsPerKey(0, 7)).toBe(7);
  });
});

describe("isKeyRotatableError / isKeyCircleStopError", () => {
  const retriable = (e: unknown) =>
    e instanceof ProviderError && (e.status === 429 || (e.status ?? 0) >= 500);

  it("rotates on 401 and 429", () => {
    expect(isKeyRotatableError(new ProviderError("nope", 401), retriable)).toBe(true);
    expect(isKeyRotatableError(new ProviderError("rl", 429), retriable)).toBe(true);
  });

  it("stops circle on 404/422 but not 413", () => {
    expect(isKeyCircleStopError(new ProviderError("missing", 404))).toBe(true);
    expect(isKeyCircleStopError(new ProviderError("bad", 422))).toBe(true);
    expect(isKeyCircleStopError(new ProviderError("big", 413))).toBe(false);
    expect(isKeyCircleStopError(new ProviderError("rl", 429))).toBe(false);
  });

  it("detects auth key errors", () => {
    expect(isAuthKeyError(new ProviderError("nope", 401))).toBe(true);
    expect(isAuthKeyError(new ProviderError("nope", 403))).toBe(true);
    expect(isAuthKeyError(new ProviderError("rl", 429))).toBe(false);
  });

  it("treats 402 / insufficient credits as immediate key-switch (not stop-circle)", () => {
    const err = new ProviderError(
      "Provider request failed with HTTP 402 — Insufficient credits: your balance is 0",
      402,
    );
    expect(isQuotaKeyError(err)).toBe(true);
    expect(isImmediateKeySwitchError(err)).toBe(true);
    expect(isKeyCircleStopError(err)).toBe(false);
    expect(isKeyRotatableError(err, () => false)).toBe(true);
    expect(
      isQuotaKeyError(
        new Error("Insufficient credits: your balance is 0.000000000 Top up to continue."),
      ),
    ).toBe(true);
  });
});

describe("formatKeyEventStatus", () => {
  it("formats using / switch / retry", () => {
    expect(
      formatKeyEventStatus({
        type: "using",
        provider: "nvidia",
        maskedTail: "…ab12",
        keyIndex: 0,
        keyCount: 2,
      }),
    ).toContain("using nvidia");
    expect(
      formatKeyEventStatus({
        type: "switch",
        provider: "nvidia",
        maskedTail: "…cd34",
        reason: "rate limited",
        keyIndex: 1,
        keyCount: 2,
      }),
    ).toMatch(/switching.*rate limited/);
    expect(
      formatKeyEventStatus({
        type: "retry",
        provider: "nvidia",
        maskedTail: "…ab12",
        reason: "rate limited",
        waitMs: 2000,
      }),
    ).toMatch(/rate limited.*retrying in 2s/);
  });
});
