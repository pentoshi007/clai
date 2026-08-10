import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../../src/llm/http.js";
import { completeWithProvider } from "../../src/llm/router.js";
import { summarizeForSessionCompact } from "../../src/app/controllers/session-compact-helper.js";

vi.mock("../../src/llm/router.js", () => ({
  completeWithProvider: vi.fn(),
  streamWithProvider: vi.fn(),
}));

const completeMock = vi.mocked(completeWithProvider);

const SUMMARY =
  "The session covered the release work.\n\n- Updated the provider code.\n- All checks passed.";

function okResult() {
  return {
    text: SUMMARY,
    provider: "free",
    model: "free-1/deepseek-v4-flash-free",
    finishReason: "stop",
  };
}

describe("compaction server-error retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries once on a 500 and returns the summary when the second attempt succeeds", async () => {
    completeMock
      .mockRejectedValueOnce(new ProviderError("upstream 500", 500))
      .mockResolvedValueOnce(okResult() as never);

    const result = await summarizeForSessionCompact("compact this", {
      provider: "free",
      model: "free-1/deepseek-v4-flash-free",
    });

    expect(result).toContain("release work");
    expect(completeMock).toHaveBeenCalledTimes(2);
  });

  it("throws only after the second 500 fails", async () => {
    completeMock.mockRejectedValue(new ProviderError("upstream 500", 500));

    await expect(
      summarizeForSessionCompact("compact this", {
        provider: "free",
        model: "free-1/deepseek-v4-flash-free",
      }),
    ).rejects.toThrow(/500/);
    expect(completeMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-server errors", async () => {
    completeMock.mockRejectedValue(new ProviderError("auth failed", 401));

    await expect(
      summarizeForSessionCompact("compact this", {
        provider: "free",
        model: "free-1/deepseek-v4-flash-free",
      }),
    ).rejects.toThrow(/auth failed/);
    expect(completeMock).toHaveBeenCalledTimes(1);
  });

  it("retries on internal-server-error wording without a status", async () => {
    completeMock
      .mockRejectedValueOnce(
        new Error("Provider request failed — Internal server error"),
      )
      .mockResolvedValueOnce(okResult() as never);

    const result = await summarizeForSessionCompact("compact this", {
      provider: "free",
      model: "free-1/deepseek-v4-flash-free",
    });

    expect(result).toContain("release work");
    expect(completeMock).toHaveBeenCalledTimes(2);
  });
});
