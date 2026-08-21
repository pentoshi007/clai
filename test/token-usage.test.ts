import { describe, expect, it } from "vitest";
import {
  applyUsageToSnapshot,
  formatContextChip,
  formatTokenCount,
  mergeAnthropicStreamUsage,
  modelContextWindow,
  parseAnthropicUsage,
  parseGeminiUsage,
  parseOllamaUsage,
  parseOpenAiUsage,
} from "../src/llm/token-usage.js";

describe("token-usage parsers", () => {
  it("parses OpenAI usage (snake + camel)", () => {
    expect(
      parseOpenAiUsage({
        prompt_tokens: 1200,
        completion_tokens: 80,
        total_tokens: 1280,
      }),
    ).toEqual({
      promptTokens: 1200,
      completionTokens: 80,
      totalTokens: 1280,
      exact: true,
    });
    expect(
      parseOpenAiUsage({
        promptTokens: 10,
        completionTokens: 5,
      }),
    ).toMatchObject({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  it("parses Anthropic / Gemini / Ollama usage", () => {
    expect(
      parseAnthropicUsage({ input_tokens: 100, output_tokens: 20 }),
    ).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      exact: true,
    });
    expect(
      parseGeminiUsage({
        promptTokenCount: 50,
        candidatesTokenCount: 10,
        totalTokenCount: 60,
      }),
    ).toMatchObject({ promptTokens: 50, completionTokens: 10, totalTokens: 60 });
    expect(
      parseOllamaUsage({ prompt_eval_count: 40, eval_count: 12 }),
    ).toMatchObject({ promptTokens: 40, completionTokens: 12 });
  });

  it("preserves Anthropic cache telemetry when the output delta arrives", () => {
    const started = parseAnthropicUsage({
      input_tokens: 16,
      cache_read_input_tokens: 48_000,
      cache_creation_input_tokens: 2_000,
      output_tokens: 0,
    });
    const delta = parseAnthropicUsage({ output_tokens: 120 });
    expect(mergeAnthropicStreamUsage(started, delta!)).toEqual({
      promptTokens: 50_016,
      completionTokens: 120,
      totalTokens: 50_136,
      exact: true,
      cachedPromptTokens: 48_000,
      cacheCreationTokens: 2_000,
    });
  });

  it("returns undefined for empty usage", () => {
    expect(parseOpenAiUsage(undefined)).toBeUndefined();
    expect(parseOpenAiUsage({})).toBeUndefined();
  });

  it("counts Anthropic cache-read/creation tokens as context fill", () => {
    expect(
      parseAnthropicUsage({
        input_tokens: 16,
        cache_read_input_tokens: 48_000,
        cache_creation_input_tokens: 2_000,
        output_tokens: 120,
      }),
    ).toEqual({
      promptTokens: 50_016,
      completionTokens: 120,
      totalTokens: 50_136,
      exact: true,
      cachedPromptTokens: 48_000,
      cacheCreationTokens: 2_000,
    });
    expect(
      parseAnthropicUsage({ cache_read_input_tokens: 30_000, output_tokens: 5 }),
    ).toMatchObject({ promptTokens: 30_000, completionTokens: 5 });
  });
});

describe("token-usage format + context window", () => {
  it("formats counts and context chips against the request budget", () => {
    expect(formatTokenCount(12450)).toBe("12,450");
    expect(formatTokenCount(128_000, true)).toBe("128k");
    expect(
      formatContextChip({
        contextTokens: 54_000,
        contextLimit: 80_000,
        lastCompletionTokens: 80,
        sessionPromptTokens: 54_000,
        sessionCompletionTokens: 80,
        exact: true,
      }),
    ).toBe("ctx 54,000/80k 68%");
    expect(
      formatContextChip(
        {
          contextTokens: 12_450,
          contextLimit: 80_000,
          lastCompletionTokens: 0,
          sessionPromptTokens: 0,
          sessionCompletionTokens: 0,
          exact: false,
        },
        { compact: true },
      ),
    ).toBe("ctx:~12.4k/80k 16%");
    expect(
      formatContextChip({
        contextTokens: 900,
        contextLimit: 0,
        lastCompletionTokens: 0,
        sessionPromptTokens: 0,
        sessionCompletionTokens: 0,
        exact: true,
      }),
    ).toBe("ctx:900");
  });

  it("resolves known model context windows", () => {
    expect(modelContextWindow("claude-sonnet-4-20250514")).toBe(200_000);
    expect(modelContextWindow("claude-sonnet-4.6")).toBe(1_000_000);
    expect(modelContextWindow("claude-fable-5")).toBe(1_000_000);
    expect(modelContextWindow("gpt-4o")).toBe(128_000);
    expect(modelContextWindow("gpt-5.5-pro")).toBe(1_050_000);
    expect(modelContextWindow("gpt-5.6-luna")).toBe(1_050_000);
    expect(modelContextWindow("gemini-2.0-flash")).toBe(1_048_576);
    expect(modelContextWindow("deepseek-v4-flash")).toBe(1_000_000);
    expect(modelContextWindow("glm-5.2")).toBe(1_000_000);
    expect(modelContextWindow("minimax-m3")).toBe(1_000_000);
    expect(modelContextWindow("moonshotai/Kimi-K3")).toBe(1_000_000);
    expect(modelContextWindow("Qwen/Qwen3.8-2.4T-A95B", "modal")).toBe(
      262_144,
    );
    expect(modelContextWindow("qwen3.7-plus")).toBe(1_000_000);
    expect(modelContextWindow("kimi-k2.6", "tokenrouter")).toBe(262_144);
    expect(modelContextWindow("unknown-model-xyz")).toBe(250_000);
  });

  it("accumulates session totals and latest context fill", () => {
    const a = applyUsageToSnapshot(
      undefined,
      {
        promptTokens: 1000,
        completionTokens: 50,
        totalTokens: 1050,
        exact: true,
      },
      128_000,
    );
    expect(a.contextTokens).toBe(1000);
    expect(a.sessionPromptTokens).toBe(1000);
    expect(a.exact).toBe(true);

    const b = applyUsageToSnapshot(
      a,
      {
        promptTokens: 2500,
        completionTokens: 100,
        totalTokens: 2600,
        exact: true,
      },
      128_000,
    );
    expect(b.contextTokens).toBe(2500);
    expect(b.sessionPromptTokens).toBe(3500);
    expect(b.sessionCompletionTokens).toBe(150);
  });
});


describe("OpenAI usage detail (cache / reasoning)", () => {
  it("keeps cached prompt and reasoning token detail", () => {
    expect(
      parseOpenAiUsage({
        prompt_tokens: 1_000,
        completion_tokens: 500,
        total_tokens: 1_500,
        prompt_tokens_details: { cached_tokens: 800 },
        completion_tokens_details: { reasoning_tokens: 420 },
      }),
    ).toEqual({
      promptTokens: 1_000,
      completionTokens: 500,
      totalTokens: 1_500,
      exact: true,
      cachedPromptTokens: 800,
      reasoningTokens: 420,
    });
  });


  it("parses OpenRouter cache writes and Responses detail shapes", () => {
    expect(
      parseOpenAiUsage({
        prompt_tokens: 2_000,
        completion_tokens: 300,
        prompt_tokens_details: {
          cached_tokens: 1_500,
          cache_write_tokens: 400,
        },
        completion_tokens_details: { reasoning_tokens: 250 },
      }),
    ).toMatchObject({
      cachedPromptTokens: 1_500,
      cacheCreationTokens: 400,
      reasoningTokens: 250,
    });
    expect(
      parseOpenAiUsage({
        input_tokens: 3_000,
        output_tokens: 500,
        input_tokens_details: {
          cached_tokens: 2_800,
          cache_write_tokens: 100,
        },
        output_tokens_details: { reasoning_tokens: 450 },
      }),
    ).toMatchObject({
      promptTokens: 3_000,
      completionTokens: 500,
      cachedPromptTokens: 2_800,
      cacheCreationTokens: 100,
      reasoningTokens: 450,
    });
  });
  it("omits the detail fields when the gateway does not report them", () => {
    expect(
      parseOpenAiUsage({ prompt_tokens: 10, completion_tokens: 2 }),
    ).toEqual({
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
      exact: true,
    });
  });
});


describe("modelContextWindow sizing", () => {
  it("sizes current defaults correctly", () => {
    expect(modelContextWindow("gemini-3.5-flash")).toBe(1_048_576);
    expect(modelContextWindow("kimi-k2.6")).toBe(256_000);
    expect(modelContextWindow("z-ai/glm-5.2")).toBe(1_000_000);
    expect(modelContextWindow("gpt-4")).toBe(8_192);
    expect(modelContextWindow("gpt-4-32k")).toBe(32_768);
    expect(modelContextWindow("gpt-4o")).toBe(128_000);
  });

  it("honors provider-specific served windows", () => {
    expect(modelContextWindow("MiniMax-M3")).toBe(1_000_000);
    expect(modelContextWindow("MiniMax-M3", "tokenrouter")).toBe(524_288);
    expect(modelContextWindow("openai/gpt-oss-120b", "tokenrouter")).toBe(131_072);
  });
});
