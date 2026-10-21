import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../../src/llm/http.js";
import { observedOutputCap, resetRememberedModelLimits } from "../../src/llm/model-limit-store.js";
import {
  outputTokenRejection,
  withRequestOptionFallback,
} from "../../src/llm/routing/request-option-fallback.js";
import type { CompletionRequest } from "../../src/types.js";

let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  originalDataDir = process.env.CLAI_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "clai-output-cap-"));
  process.env.CLAI_DATA_DIR = dataDir;
  resetRememberedModelLimits();
});

afterEach(() => {
  resetRememberedModelLimits();
  if (originalDataDir === undefined) delete process.env.CLAI_DATA_DIR;
  else process.env.CLAI_DATA_DIR = originalDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const rejection = (body: string, status = 400) =>
  new ProviderError("Gateway rejected the request", status, body);

const request: CompletionRequest = {
  provider: "tokenrouter",
  model: "vendor/reasoner",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 131_072,
};

describe("output token rejections", () => {
  it.each([
    ["max_tokens is too large: 131072. This model supports at most 16384 completion tokens, whereas you provided 131072.", 16_384],
    ["max_tokens: 131072 > 64000, which is the maximum allowed number of output tokens for claude-x", 64_000],
    ["Invalid max_tokens value, the valid range of max_tokens is [1, 8192]", 8_192],
    ["`max_tokens` must be less than or equal to `32768`, the maximum value for `max_tokens`", 32_768],
    ["The maximum number of output tokens allowed is 65,536 for this model (max_output_tokens)", 65_536],
    ["Unable to submit request because it has a maxOutputTokens value of 131072 but the supported range is from 1 (inclusive) to 65537 (exclusive)", 65_536],
  ])("learns the model cap from %j", (body, maxTokens) => {
    expect(outputTokenRejection(rejection(body))).toEqual({ maxTokens, modelCap: true });
  });

  it("fits the request into the stated context without treating it as a model cap", () => {
    expect(outputTokenRejection(rejection(
      "'max_tokens' or 'max_completion_tokens' is too large: 131072. This model's maximum context length is 131072 tokens and your request has 10969 input tokens (131072 > 131072 - 10969).",
    ))).toEqual({ maxTokens: 131_072 - 10_969 - 256, modelCap: false });
  });

  it.each([
    [rejection("This model's maximum context length is 131072 tokens. Please reduce the length of the messages.")],
    [rejection("max_tokens is too large", 500)],
    [new Error("supports at most 16384 completion tokens")],
  ])("ignores unrelated failures", (error) => {
    expect(outputTokenRejection(error)).toBeUndefined();
  });

  it("retries once with the learned cap and remembers it for the route", async () => {
    const attempt = vi.fn(async (candidate: CompletionRequest) => {
      if (candidate.maxTokens! > 16_384) {
        throw rejection("This model supports at most 16384 completion tokens, whereas you provided 131072.");
      }
      return candidate.maxTokens;
    });
    await expect(withRequestOptionFallback(request, "initial", attempt, () => true, undefined))
      .resolves.toBe(16_384);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt.mock.calls[1]![1]).toBe("adaptation");
    expect(observedOutputCap("tokenrouter", "vendor/reasoner")).toBe(16_384);
  });

  it("retries a context-fit rejection without remembering a model cap", async () => {
    const attempt = vi.fn(async (candidate: CompletionRequest) => {
      if (candidate.maxTokens! > 100_816) {
        throw rejection("max_tokens is too large. This model's maximum context length is 131072 tokens and your request has 30000 input tokens.");
      }
      return candidate.maxTokens;
    });
    await expect(withRequestOptionFallback(request, "initial", attempt, () => true, undefined))
      .resolves.toBe(100_816);
    expect(observedOutputCap("tokenrouter", "vendor/reasoner")).toBeUndefined();
  });

  it("does not retry when the stated limit would not lower the request", async () => {
    const error = rejection("This model supports at most 200000 completion tokens.");
    const attempt = vi.fn(async () => { throw error; });
    await expect(withRequestOptionFallback(request, "initial", attempt, () => true, undefined))
      .rejects.toBe(error);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(observedOutputCap("tokenrouter", "vendor/reasoner")).toBeUndefined();
  });
});
