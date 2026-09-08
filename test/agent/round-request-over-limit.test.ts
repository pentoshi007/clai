import { describe, expect, it, vi } from "vitest";
import { RequestOverLimitError } from "../../src/agent/request-accounting.js";
import { recoverDispatchOverLimit } from "../../src/agent/turn/loop/round-request.js";
import type { ChatMessage } from "../../src/types.js";

function requestSize(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}

describe("dispatch-over-limit recovery", () => {
  it("continues only after compaction strictly shrinks the next request", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "oversized history" },
      { role: "assistant", content: "large response" },
    ];
    const maybeAutoCompact = vi.fn(async () => {
      messages.splice(0, 2, { role: "system", content: "summary" });
    });
    const error = new RequestOverLimitError("dispatch blocked");

    await expect(
      recoverDispatchOverLimit(
        {
          messages,
          estimateNextRequestTokens: requestSize,
          maybeAutoCompact,
        },
        error,
      ),
    ).resolves.toBeUndefined();
    expect(maybeAutoCompact).toHaveBeenCalledTimes(1);
    expect(maybeAutoCompact).toHaveBeenCalledWith("dispatch-over-limit", {
      bypassThreshold: true,
    });
  });

  it("rethrows the original error when compaction is suppressed or makes no progress", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "unchanged oversized history" },
    ];
    const maybeAutoCompact = vi.fn(async () => undefined);
    const error = new RequestOverLimitError("dispatch blocked");

    await expect(
      recoverDispatchOverLimit(
        {
          messages,
          estimateNextRequestTokens: requestSize,
          maybeAutoCompact,
        },
        error,
      ),
    ).rejects.toBe(error);
    expect(maybeAutoCompact).toHaveBeenCalledTimes(1);
  });
});
