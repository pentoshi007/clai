import { describe, expect, it } from "vitest";
import { classifyNvidiaModel } from "../src/llm/http.js";

describe("NVIDIA NIM model classification", () => {
  it("routes DeepSeek/Kimi/Nemotron to chat_template_kwargs.thinking", () => {
    expect(classifyNvidiaModel("deepseek-ai/deepseek-v4-flash")).toBe("thinking");
    expect(classifyNvidiaModel("deepseek-ai/deepseek-v4-pro")).toBe("thinking");
    expect(classifyNvidiaModel("deepseek-ai/deepseek-v3.1-terminus")).toBe("thinking");
    expect(classifyNvidiaModel("deepseek-ai/deepseek-r1")).toBe("thinking");
    expect(classifyNvidiaModel("moonshotai/kimi-k2.6")).toBe("thinking");
    expect(classifyNvidiaModel("moonshotai/kimi-k2-instruct")).toBe("thinking");
    expect(classifyNvidiaModel("nvidia/llama-3.3-nemotron-super-49b-v1")).toBe("thinking");
  });

  it("routes GLM and Gemma to chat_template_kwargs.enable_thinking", () => {
    expect(classifyNvidiaModel("z-ai/glm-5.1")).toBe("enable-thinking");
    expect(classifyNvidiaModel("z-ai/glm-5")).toBe("enable-thinking");
    expect(classifyNvidiaModel("google/gemma-4-31b-it")).toBe("enable-thinking");
    expect(classifyNvidiaModel("google/gemma-3-27b-it")).toBe("enable-thinking");
  });

  it("routes gpt-oss and qwen3 to top-level reasoning_effort", () => {
    expect(classifyNvidiaModel("openai/gpt-oss-120b")).toBe("effort-only");
    expect(classifyNvidiaModel("openai/gpt-oss-20b")).toBe("effort-only");
    expect(classifyNvidiaModel("qwen/qwen3-235b-a22b")).toBe("effort-only");
  });

  it("returns 'none' for non-thinking model families", () => {
    expect(classifyNvidiaModel("meta/llama-3.3-70b-instruct")).toBe("none");
    expect(classifyNvidiaModel("mistralai/mistral-large-2-instruct")).toBe("none");
    expect(classifyNvidiaModel("minimaxai/minimax-m2.7")).toBe("none");
    expect(classifyNvidiaModel("minimaxai/minimax-m2.5")).toBe("none");
  });
});
