import { describe, expect, it } from "vitest";
import {
  buildReasoningPayload,
  classifyNvidiaModel,
} from "../src/llm/http.js";
import { geminiBody } from "../src/llm/gemini.js";

describe("NVIDIA NIM model classification", () => {
  it("routes Kimi and DeepSeek V4 to their explicit NIM reasoning controls", () => {
    expect(classifyNvidiaModel("moonshotai/kimi-k2.6")).toBe("kimi-thinking");
    expect(classifyNvidiaModel("moonshotai/kimi-k2-instruct")).toBe("kimi-thinking");
    expect(classifyNvidiaModel("deepseek-ai/deepseek-v4-flash")).toBe("deepseek-v4");
    expect(classifyNvidiaModel("deepseek-ai/deepseek-v4-pro")).toBe("deepseek-v4");
  });

  it("routes older DeepSeek and Nemotron to chat_template_kwargs.thinking", () => {
    expect(classifyNvidiaModel("deepseek-ai/deepseek-v3.1-terminus")).toBe("thinking");
    expect(classifyNvidiaModel("deepseek-ai/deepseek-r1")).toBe("thinking");
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

  it("turns Kimi reasoning off explicitly because NIM enables it by default", () => {
    expect(
      buildReasoningPayload(
        { enabled: false, effort: "medium" },
        "nvidia",
        "moonshotai/kimi-k2.6",
      ),
    ).toEqual({ chat_template_kwargs: { thinking: false } });
  });

  it("maps DeepSeek V4 off/on to NIM's none/high reasoning effort", () => {
    expect(
      buildReasoningPayload(
        { enabled: false, effort: "medium" },
        "nvidia",
        "deepseek-ai/deepseek-v4-flash",
      ),
    ).toEqual({
      chat_template_kwargs: { thinking: false, reasoning_effort: "none" },
    });
    expect(
      buildReasoningPayload(
        { enabled: true, effort: "medium" },
        "nvidia",
        "deepseek-ai/deepseek-v4-flash",
      ),
    ).toEqual({
      chat_template_kwargs: { thinking: true, reasoning_effort: "high" },
    });
  });

  it("sends GLM's clear_thinking flag when thinking is enabled", () => {
    expect(
      buildReasoningPayload(
        { enabled: true, effort: "high" },
        "nvidia",
        "z-ai/glm-5.1",
      ),
    ).toEqual({
      chat_template_kwargs: { enable_thinking: true, clear_thinking: false },
    });
  });

  it("does not send Groq reasoning_effort to non-reasoning Groq models", () => {
    expect(
      buildReasoningPayload(
        { enabled: true, effort: "medium" },
        "groq",
        "llama-3.3-70b-versatile",
      ),
    ).toEqual({});
  });

  it("keeps OpenRouter reasoning payloads separate from Groq and NVIDIA fields", () => {
    const payload = buildReasoningPayload(
      { enabled: true, effort: "high" },
      "openrouter",
      "moonshotai/kimi-k2:free",
    );
    expect(payload).toEqual({ reasoning: { enabled: true, effort: "high" } });
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(payload).not.toHaveProperty("chat_template_kwargs");
  });

  it("does not send OpenRouter reasoning to models that do not advertise it", () => {
    expect(
      buildReasoningPayload(
        { enabled: true, effort: "high" },
        "openrouter",
        "meta-llama/llama-3.3-70b-instruct:free",
      ),
    ).toEqual({});
  });

  it("keeps Gemini thinking config inside Gemini generationConfig only", () => {
    const body = JSON.parse(
      geminiBody({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "hi" }],
        thinking: { enabled: true, effort: "low" },
      }),
    ) as Record<string, unknown>;
    const generationConfig = body.generationConfig as Record<string, unknown>;
    expect(generationConfig.thinkingConfig).toEqual({
      thinkingBudget: 1024,
      includeThoughts: true,
    });
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("chat_template_kwargs");
  });

  it("does not send Gemini thinkingConfig to non-thinking Gemini models", () => {
    const body = JSON.parse(
      geminiBody({
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "hi" }],
        thinking: { enabled: true, effort: "high" },
      }),
    ) as { generationConfig?: Record<string, unknown> };
    expect(body.generationConfig).not.toHaveProperty("thinkingConfig");
  });
});
