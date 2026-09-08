import { describe, expect, it } from "vitest";
import { parseResponsesUsage } from "../../src/llm/responses-parse.js";

describe("parseResponsesUsage cache token shapes", () => {
  it("reads gateway responses usage with cache_write_tokens detail", () => {
    const usage = parseResponsesUsage({
      input_tokens: 2829,
      output_tokens: 127,
      total_tokens: 2956,
      input_tokens_details: { cached_tokens: 2816, cache_write_tokens: 13 },
      output_tokens_details: { reasoning_tokens: 123 },
    });
    expect(usage?.promptTokens).toBe(2829);
    expect(usage?.cachedPromptTokens).toBe(2816);
    expect(usage?.cacheCreationTokens).toBe(13);
    expect(usage?.reasoningTokens).toBe(123);
  });

  it("reads deepseek chat-style prompt_cache_hit_tokens", () => {
    const usage = parseResponsesUsage({
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 105,
      prompt_cache_hit_tokens: 64,
      prompt_cache_miss_tokens: 36,
    });
    expect(usage?.cachedPromptTokens).toBe(64);
    expect(usage?.uncachedPromptTokens).toBe(36);
  });

  it("reads anthropic-style cache_read_input_tokens", () => {
    const usage = parseResponsesUsage({
      input_tokens: 40,
      output_tokens: 4,
      total_tokens: 44,
      cache_read_input_tokens: 32,
      cache_creation_input_tokens: 8,
    });
    expect(usage?.cachedPromptTokens).toBe(32);
    expect(usage?.cacheCreationTokens).toBe(8);
  });

  it("reads cache_write_input_tokens at top level", () => {
    const usage = parseResponsesUsage({
      input_tokens: 20,
      output_tokens: 2,
      total_tokens: 22,
      cache_write_input_tokens: 6,
    });
    expect(usage?.cacheCreationTokens).toBe(6);
  });

  it("keeps prompt_tokens_details cached_tokens precedence", () => {
    const usage = parseResponsesUsage({
      prompt_tokens: 10,
      completion_tokens: 3,
      total_tokens: 13,
      prompt_tokens_details: { cached_tokens: 7 },
    });
    expect(usage?.cachedPromptTokens).toBe(7);
  });

  it("returns undefined for non-object usage", () => {
    expect(parseResponsesUsage("x")).toBeUndefined();
    expect(parseResponsesUsage(undefined)).toBeUndefined();
    expect(parseResponsesUsage([1, 2])).toBeUndefined();
  });
});
