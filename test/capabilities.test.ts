import { describe, expect, it } from "vitest";
import { modelSupportsThinking } from "../src/llm/capabilities.js";

describe("modelSupportsThinking", () => {
  it("recognizes Kimi K2.6 on NVIDIA NIM", () => {
    expect(modelSupportsThinking("nvidia", "moonshotai/kimi-k2.6")).toBe(true);
  });

  it("recognizes DeepSeek R1 on NVIDIA and current Groq reasoning models", () => {
    expect(modelSupportsThinking("nvidia", "deepseek-ai/deepseek-r1")).toBe(true);
    expect(modelSupportsThinking("groq", "qwen/qwen3-32b")).toBe(true);
    expect(modelSupportsThinking("groq", "openai/gpt-oss-20b")).toBe(true);
  });

  it("recognizes GPT-5/o-series on OpenAI", () => {
    expect(modelSupportsThinking("openai", "gpt-5.5")).toBe(true);
    expect(modelSupportsThinking("openai", "o3-mini")).toBe(true);
  });

  it("returns false for non-thinking models", () => {
    expect(modelSupportsThinking("openai", "gpt-4o-mini")).toBe(false);
    expect(modelSupportsThinking("groq", "llama-3.3-70b-versatile")).toBe(false);
  });
});
