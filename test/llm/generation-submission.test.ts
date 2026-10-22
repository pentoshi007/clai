import { afterEach, describe, expect, it, vi } from "vitest";
import { acknowledgeGenerationSubmission, withGenerationSubmission } from "../../src/llm/generation-submission.js";
import { generationFetch, runGenerationAttempt, withUnrecordedTransport } from "../../src/llm/operation-usage.js";
import type { CompletionRequest } from "../../src/types.js";

const request: CompletionRequest = { provider: "free", model: "fixture", messages: [{ role: "user", content: "prompt" }] };
afterEach(() => vi.unstubAllGlobals());

describe("model submission acknowledgment", () => {
  it("acknowledges a successful response before any stream body is consumed", async () => {
    const acknowledged = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start() {} }))));
    await withGenerationSubmission(acknowledged, async () => {
      const response = await generationFetch("https://fixture.invalid/model");
      expect(acknowledged).toHaveBeenCalledOnce();
      await response.body?.cancel();
    });
  });

  it("does not consume a prompt on rejection, failed transport, or auxiliary requests", async () => {
    const acknowledged = vi.fn();
    const fetch = vi.fn().mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(new Response("auxiliary"));
    vi.stubGlobal("fetch", fetch);
    await withGenerationSubmission(acknowledged, async () => {
      await generationFetch("https://fixture.invalid/model");
      await expect(generationFetch("https://fixture.invalid/model")).rejects.toThrow("connection refused");
      await withUnrecordedTransport(() => generationFetch("https://fixture.invalid/token-count"));
    });
    expect(acknowledged).not.toHaveBeenCalled();
  });

  it("acknowledges once across retries and supports non-fetch providers", async () => {
    const acknowledged = vi.fn();
    await withGenerationSubmission(acknowledged, async () => {
      await runGenerationAttempt(request, { provider: "free", model: "fixture", mode: "stream", reason: "initial" },
        async () => ({ text: "done", provider: "free", model: "fixture" }));
      acknowledgeGenerationSubmission();
    });
    expect(acknowledged).toHaveBeenCalledOnce();
    acknowledgeGenerationSubmission();
    expect(acknowledged).toHaveBeenCalledOnce();
  });

  it("isolates concurrent turns", async () => {
    const first = vi.fn();
    const second = vi.fn();
    await Promise.all([first, second].map((acknowledge) => withGenerationSubmission(acknowledge, async () => {
      await Promise.resolve();
      acknowledgeGenerationSubmission();
      acknowledgeGenerationSubmission();
    })));
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });
});
