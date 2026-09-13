import { describe, expect, it } from "vitest";
import type { CompletionRequest, ReasoningPreference } from "../../src/types.js";
import {
  EFFORT_LADDER,
  effortCandidates,
  fallbackEffortsFor,
  isEffortRejectedError,
  withEffortFallback,
} from "../../src/llm/effort-fallback.js";

function effortError(status: number, body: string): Error & { status: number; body: string } {
  const err = new Error(body) as Error & { status: number; body: string };
  err.status = status;
  err.body = body;
  return err;
}

describe("fallbackEffortsFor", () => {
  it("descends the full ladder from max", () => {
    expect(fallbackEffortsFor("max")).toEqual([
      "xhigh",
      "high",
      "medium",
      "low",
      "minimal",
      "none",
    ]);
  });

  it("descends from xhigh", () => {
    expect(fallbackEffortsFor("xhigh")).toEqual([
      "high",
      "medium",
      "low",
      "minimal",
      "none",
    ]);
  });

  it("keeps descending below the classic low/medium/high set", () => {
    expect(fallbackEffortsFor("high")).toEqual(["medium", "low", "minimal", "none"]);
    expect(fallbackEffortsFor("medium")).toEqual(["low", "minimal", "none"]);
    expect(fallbackEffortsFor("low")).toEqual(["minimal", "none"]);
  });

  it("can only fall back to disable from minimal", () => {
    expect(fallbackEffortsFor("minimal")).toEqual(["none"]);
    expect(fallbackEffortsFor("none")).toEqual([]);
  });

  it("never includes the requested effort itself", () => {
    for (const effort of EFFORT_LADDER) {
      expect(fallbackEffortsFor(effort)).not.toContain(effort);
    }
  });
});

describe("effortCandidates", () => {
  it("starts with the requested effort then its ladder", () => {
    expect(effortCandidates({ enabled: true, effort: "max" })).toEqual([
      "max",
      "xhigh",
      "high",
      "medium",
      "low",
      "minimal",
      "none",
    ]);
  });

  it("defaults to medium then descends when no thinking is supplied", () => {
    expect(effortCandidates(undefined)).toEqual([
      "medium",
      "low",
      "minimal",
      "none",
    ]);
  });

  it("deduplicates", () => {
    const thinking: ReasoningPreference = { enabled: true, effort: "medium" };
    expect(effortCandidates(thinking)).toEqual([
      "medium",
      "low",
      "minimal",
      "none",
    ]);
  });
});

describe("isEffortRejectedError", () => {
  it("detects a 400 reasoning_effort rejection", () => {
    expect(
      isEffortRejectedError(
        effortError(400, "reasoning_effort must be one of: low, medium, high"),
      ),
    ).toBe(true);
  });

  it("detects a 422 unsupported effort rejection", () => {
    expect(
      isEffortRejectedError(effortError(422, "reasoning effort 'max' is not supported")),
    ).toBe(true);
  });

  it("ignores non-4xx errors", () => {
    expect(isEffortRejectedError(effortError(500, "reasoning_effort invalid"))).toBe(false);
    expect(isEffortRejectedError(new Error("network down"))).toBe(false);
  });

  it("ignores 400 errors unrelated to reasoning", () => {
    expect(isEffortRejectedError(effortError(400, "invalid api key"))).toBe(false);
  });
});

describe("withEffortFallback", () => {
  const request: CompletionRequest = {
    model: "test-model",
    thinking: { enabled: true, effort: "max" },
  } as CompletionRequest;

  it("returns immediately when thinking is disabled", async () => {
    const attempts: string[] = [];
    const result = await withEffortFallback(
      { ...request, thinking: { enabled: false, effort: "low" } },
      async (thinking) => {
        attempts.push(thinking?.effort ?? "none");
        return "ok";
      },
      () => {
        throw new Error("should not exhaust");
      },
    );
    expect(result).toBe("ok");
    expect(attempts).toEqual(["low"]);
  });

  it("walks the ladder until an attempt succeeds", async () => {
    const attempts: string[] = [];
    const result = await withEffortFallback(
      request,
      async (thinking) => {
        const effort = thinking?.effort ?? "none";
        attempts.push(effort);
        if (effort === "max" || effort === "xhigh") {
          throw effortError(400, "reasoning_effort must be one of: low, medium, high");
        }
        return `accepted:${effort}`;
      },
      () => {
        throw new Error("should not exhaust");
      },
    );
    expect(result).toBe("accepted:high");
    expect(attempts).toEqual(["max", "xhigh", "high"]);
  });

  it("propagates non-effort errors immediately", async () => {
    const attempts: string[] = [];
    await expect(
      withEffortFallback(
        request,
        async (thinking) => {
          attempts.push(thinking?.effort ?? "none");
          throw new Error("network down");
        },
        () => {
          throw new Error("should not exhaust");
        },
      ),
    ).rejects.toThrow("network down");
    expect(attempts).toEqual(["max"]);
  });

  it("rethrows the last effort error when exhausted", async () => {
    const attempts: string[] = [];
    await expect(
      withEffortFallback(
        request,
        async (thinking) => {
          attempts.push(thinking?.effort ?? "none");
          throw effortError(422, "reasoning effort not supported");
        },
        () => {
          throw new Error("onExhausted should not be called");
        },
      ),
    ).rejects.toThrow("reasoning effort not supported");
    expect(attempts).toEqual([
      "max",
      "xhigh",
      "high",
      "medium",
      "low",
      "minimal",
      "none",
    ]);
  });
});
